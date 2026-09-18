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

test("publication readback retries only absence with fresh fences and one mutation", async () => {
  for (const scenario of ["delayed", "absent", "conflict", "lost-fence"]) {
    const body = {
      id: "exact-tag",
      kind: "exact-tag",
      tag: "v1.0.0",
      commit: "a".repeat(40),
    };
    const effect = { ...body, root: recordDigest(body) };
    let writes = 0,
      reads = 0,
      lag = 2,
      fences = 0;
    const receipts = [];
    const failure = new Error("lost write response");
    const invocation = applyPipelineEffects({
      effects: [effect],
      transactionRoot: recordDigest("transaction"),
      receipts,
      provider: {
        observe: async () => {
          reads++;
          if (!writes || scenario === "absent") return { state: "absent" };
          if (scenario === "conflict")
            return { state: "present", commit: "b".repeat(40) };
          return lag-- > 0
            ? { state: "absent" }
            : { state: "present", commit: body.commit };
        },
        matches: (_effect, value) =>
          value.state === "present" && value.commit === body.commit,
        apply: async () => {
          writes++;
          throw failure;
        },
      },
      fence: async () => {
        fences++;
        if (scenario === "lost-fence" && writes)
          throw new Error("writer fence lost");
      },
      retain: async (receipt) => receipts.push(receipt),
    });
    if (scenario === "delayed") {
      await invocation;
      assert.equal(receipts.at(-1).state, "success");
      assert.ok(fences >= 5);
    } else {
      await assert.rejects(
        invocation,
        scenario === "lost-fence"
          ? /writer fence lost/
          : (error) => error === failure,
      );
      assert.equal(receipts.length, 1);
    }
    assert.equal(writes, 1);
    assert.equal(
      reads,
      scenario === "conflict" ? 2 : scenario === "lost-fence" ? 1 : 4,
    );
  }
});

test("npm publisher executes only the exact sealed tarball and excludes product commands and unrelated credentials", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-npm-provider-"),
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
    tag: "alpha",
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
  assert.equal(invocation.args[invocation.args.indexOf("--tag") + 1], "alpha");
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

test("npm publication failures expose only recognized error codes and retain one sealed write", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-npm-failure-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "sealed.tgz");
  fs.writeFileSync(file, "sealed test payload");
  const bytes = publicationFile(file);
  const artifact = {
    id: "p/linux/pkg",
    file: "sealed.tgz",
    digest: bytes.digest,
    package: {
      name: "@example/pkg",
      version: "1.0.0",
      integrity: bytes.integrity,
    },
  };
  const effect = {
    kind: "npm-package",
    product: artifact.id,
    ...artifact.package,
    access: "public",
    tag: "latest",
  };
  for (const [stderr, code] of [
    ["npm error code ENEEDAUTH", "ENEEDAUTH"],
    ["npm ERR! code E403", "E403"],
    ["\u001b[31mnpm error\u001b[39m code E401\r\n", "E401"],
    ["npm error code PRIVATE_CREDENTIAL", "unclassified"],
    ["npm error code E403_PRIVATE_CREDENTIAL", "unclassified"],
    ["unrelated ENEEDAUTH", "unclassified"],
  ]) {
    let writes = 0;
    const provider = pipelineNpmProvider({
      directory,
      artifacts: [artifact],
      environment: {},
      run: (request) => {
        writes++;
        assert.equal(request.args[0], "publish");
        assert.equal(request.args[1], file);
        return {
          status: 1,
          stdout: "private stdout",
          stderr: `${stderr}\nhttps://private.invalid/?token=private-secret`,
        };
      },
    });
    await assert.rejects(provider.apply(effect), (error) => {
      assert.equal(
        error.message,
        `Sealed npm publication failed with exit 1 (npm code ${code})`,
      );
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(writes, 1);
  }
});

async function verifyGithubPublication(t, lostReleaseResponse) {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-release-provider-"),
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
  let tag,
    release,
    releaseLag = 0;
  const assets = [],
    writes = [],
    receipts = [];
  const repos = {
    listReleases: "releases",
    listReleaseAssets: "assets",
    createRelease: async (input) => {
      writes.push("release");
      release = { id: 5, ...input };
      releaseLag = lostReleaseResponse === "absent" ? Infinity : 2;
      if (lostReleaseResponse === true)
        throw new Error("lost release response");
      return { data: release };
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
      if (method === "releases" && releaseLag-- > 0)
        return map ? map({ data: [] }) : [];
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
  for (const effect of effects)
    assert.equal((await provider.observe(effect)).state, "absent");
  assert.deepEqual(writes, []);
  const input = {
    effects,
    transactionRoot: documents.transaction.transactionRoot,
    receipts,
    provider,
    fence: async () => {},
    retain: async (receipt) => receipts.push(receipt),
  };
  if (lostReleaseResponse === "absent") {
    await assert.rejects(
      applyPipelineEffects(input),
      /Release creation lacks exact provider readback/,
    );
    assert.deepEqual(writes, ["tag", "release"]);
    return;
  }
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
}

for (const scenario of [false, true, "absent"])
  test(`GitHub publication reconciles delayed visibility and lost responses (${scenario})`, (t) =>
    verifyGithubPublication(t, scenario));
