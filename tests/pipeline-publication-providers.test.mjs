import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipelineNpmProvider } from "../packages/core/publication/npm/pipeline-provider.js";
import { githubPipelineProductRelease } from "../packages/core/providers/github/pipeline-product-release.js";
import { publicationFile } from "../packages/core/publication/pipeline/files.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import {
  applyPipelineEffects,
  pipelinePublicationEffects,
} from "../packages/core/publication/pipeline/effects.js";

test("npm publisher executes only the exact sealed tarball and excludes product commands and unrelated credentials", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipeline-npm-provider-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "sealed.tgz"), "sealed test payload");
  const bytes = publicationFile(path.join(directory, "sealed.tgz"));
  const artifact = {
    id: "p/linux/pkg",
    file: "sealed.tgz",
    digest: bytes.digest,
    package: {
      name: "@example/pkg",
      version: "1.0.0-alpha.1",
      integrity: bytes.integrity,
    },
  };
  const effect = {
    kind: "npm-package",
    product: artifact.id,
    ...artifact.package,
    access: "public",
    tag: "staged",
  };
  let invocation;
  const provider = pipelineNpmProvider({
    directory,
    artifacts: [artifact],
    environment: {
      PATH: process.env.PATH,
      HOME: directory,
      NODE_OPTIONS: "untrusted",
      GITHUB_TOKEN: "private",
      AWS_SECRET_ACCESS_KEY: "private",
      NODE_AUTH_TOKEN: "publisher-only",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "publisher-oidc",
    },
    lookup: () => undefined,
    run: (request) => {
      invocation = request;
      return { status: 0 };
    },
  });
  await provider.apply(effect);
  assert.ok(invocation.args.includes("--ignore-scripts"));
  assert.equal(invocation.args[1], path.join(directory, "sealed.tgz"));
  assert.equal(invocation.env.GITHUB_TOKEN, undefined);
  assert.equal(invocation.env.NODE_OPTIONS, undefined);
  assert.equal(invocation.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(invocation.env.NODE_AUTH_TOKEN, "publisher-only");
  assert.equal(invocation.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "publisher-oidc");
  assert.ok(
    !fs
      .readFileSync(invocation.env.NPM_CONFIG_USERCONFIG, "utf8")
      .includes("publisher-only"),
  );
  assert.deepEqual(await provider.observe(effect), { state: "absent" });
  let queried = false;
  const restrictedDirectory = path.join(directory, "restricted");
  fs.mkdirSync(restrictedDirectory);
  fs.copyFileSync(
    path.join(directory, "sealed.tgz"),
    path.join(restrictedDirectory, "sealed.tgz"),
  );
  const restricted = pipelineNpmProvider({
    directory: restrictedDirectory,
    artifacts: [artifact],
    environment: {},
    lookup: () => {
      queried = true;
      return undefined;
    },
  });
  await assert.rejects(
    restricted.observe({ ...effect, access: "restricted" }),
    /read credential/,
  );
  assert.equal(queried, false);
  fs.appendFileSync(path.join(directory, "sealed.tgz"), "changed");
  await assert.rejects(provider.apply(effect), /bytes changed/);
});

test("GitHub publication reconciles lost tag/release/asset responses and refuses historical byte conflicts", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipeline-release-provider-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "product.pdf"), "%PDF-1.7\n%%EOF\n");
  const file = publicationFile(path.join(directory, "product.pdf"));
  const plan = {
    root: recordDigest("plan"),
    version: "1.0.0-alpha.1",
    tag: "v1.0.0-alpha.1",
    channel: "alpha",
  };
  const qualified = {
    source: { commit: "a".repeat(40) },
    artifacts: [
      {
        id: "paper/linux/pdf",
        file: "product.pdf",
        digest: file.digest,
        size: file.size,
        targets: [{ provider: "github-release" }],
      },
    ],
  };
  const documents = {
    transaction: { transactionRoot: recordDigest("transaction") },
    passport: { passportRoot: recordDigest("passport") },
  };
  let tag, release;
  const assets = [],
    writes = [],
    receipts = [];
  const repos = {
    listReleases: "releases",
    listReleaseAssets: "assets",
    createRelease: async (input) => {
      writes.push("release");
      release = { id: 5, ...input };
      throw new Error("lost release response");
    },
    uploadReleaseAsset: async (input) => {
      writes.push(input.name);
      assets.push({
        id: assets.length + 1,
        name: input.name,
        size: input.data.length,
        bytes: Buffer.from(input.data),
      });
      throw new Error("lost asset response");
    },
    getReleaseAsset: async ({ asset_id }) => ({
      data: assets.find(({ id }) => id === asset_id).bytes,
    }),
    updateRelease: async (input) => {
      writes.push("publish");
      release.draft = input.draft;
    },
  };
  const github = {
    rest: { repos },
    paginate: async (method, args, map) => {
      const data = method === "releases" ? (release ? [release] : []) : assets;
      return map ? map({ data }) : data;
    },
  };
  const request = async (url, options = {}) => {
    if (url.endsWith("/git/refs") && options.method === "POST") {
      writes.push("tag");
      tag = {
        ref: options.body.ref,
        object: { type: "commit", sha: options.body.sha },
      };
      throw new Error("lost tag response");
    }
    if (url.includes("/git/ref/tags/")) return tag;
    throw new Error(`Unexpected provider path ${url}`);
  };
  const provider = githubPipelineProductRelease({
    github,
    request,
    repository: "example/product",
    plan,
    qualified,
    documents,
    directory,
  });
  const effects = pipelinePublicationEffects({ plan, qualified, documents });
  const input = {
    effects,
    transactionRoot: documents.transaction.transactionRoot,
    receipts,
    provider,
    fence: async () => {},
    retain: async (receipt) => receipts.push(receipt),
  };
  await applyPipelineEffects(input);
  assert.deepEqual(writes, [
    "tag",
    "release",
    "product.pdf",
    "buildchain.release.json",
    "publish",
  ]);
  await applyPipelineEffects(input);
  assert.equal(writes.length, 5);
  assets[0].bytes = Buffer.from("conflicting historical bytes");
  await assert.rejects(applyPipelineEffects(input), /completed publication/);
  assert.equal(writes.length, 5);
});
