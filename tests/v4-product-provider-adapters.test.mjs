import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createV4ProductPublicationAdapters } from "../actions/v4-release-candidate-promote/product-provider-adapters.js";
import {
  PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
  publicationArtifactCandidateDigest,
} from "../packages/core/publication-artifact-candidate.js";
import { createPublicationSealedBundle } from "../packages/core/publication-sealed-bundle.js";
import {
  createReleaseTailTransaction,
  executeReleaseTailTransaction,
} from "../packages/core/release-tail-provider-plane.js";
import { v4ContentRoot } from "../packages/core/v4-canonical-contracts.js";
import {
  createV4ProductPublicationDeclaration,
  createV4ProductPublicationPlan,
  selectV4ProductPublicationIntent,
} from "../packages/core/v4-product-publication.js";
import { compileReleaseTailDeclaration } from "../packages/core/release-tail-provider-plane.js";

const SOURCE = "a".repeat(40);
const VERSION_STATE = "b".repeat(40);
const REBASED_VERSION_STATE = "f".repeat(40);

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeFile(root, relative, bytes) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return {
    path: relative,
    size: fs.statSync(target).size,
    sha256: digest(fs.readFileSync(target)),
  };
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "v4-product-provider-"));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify(
      {
        name: "@kungfu-tech/buildchain",
        version: "4.0.2-alpha.6",
        packageManager: "npm@11.0.0",
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(cwd, "package-lock.json"), "{}\n");
  const npm = writeFile(cwd, "sealed/buildchain.tgz", "candidate npm bytes");
  const asset = writeFile(cwd, "sealed/release.txt", "release bytes");
  const payload = {
    schemaVersion: 1,
    contract: PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
    repository: "kungfu-systems/buildchain",
    sourceSha: SOURCE,
    sourceTreeSha: "c".repeat(40),
    runtimeSha: "d".repeat(40),
    manifestDigest: "e".repeat(64),
    passportDigest: "f".repeat(64),
    controllerReceiptDigest: "1".repeat(64),
    files: [npm, asset].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
  const candidate = {
    ...payload,
    candidateDigest: publicationArtifactCandidateDigest(payload),
  };
  const manifest = createPublicationSealedBundle({
    candidate,
    packageName: "@kungfu-tech/buildchain",
    packageVersion: "4.0.2-alpha.6",
    npmTarballPath: npm.path,
    npmIntegrity: `sha512-${crypto
      .createHash("sha512")
      .update(fs.readFileSync(path.join(cwd, npm.path)))
      .digest("base64")}`,
    releaseAssetPaths: [asset.path],
  });
  const manifestPath = path.join(cwd, "sealed-bundle.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const requiredArtifacts = [
    {
      group: "node",
      kind: "npm",
      name: "@kungfu-tech/buildchain",
      ref_template: "{version}",
      role: "main",
      required: true,
    },
  ];
  const requiredArtifactsPath = path.join(cwd, "required-artifacts.json");
  fs.writeFileSync(
    requiredArtifactsPath,
    `${JSON.stringify(requiredArtifacts, null, 2)}\n`,
  );
  return {
    cwd,
    manifest,
    manifestPath,
    requiredArtifacts,
    requiredArtifactsPath,
  };
}

function githubProvider() {
  const refs = new Map([
    ["heads/alpha/v4/v4.0", SOURCE],
    ["heads/dev/v4/v4.0", SOURCE],
  ]);
  const blobs = new Map();
  const trees = new Map([["source-tree", []]]);
  const commits = new Map([
    [SOURCE, { sha: SOURCE, tree: { sha: "source-tree" }, parents: [] }],
  ]);
  const pullRequests = [];
  const checks = [];
  const protectedRefs = new Set();
  let commitCount = 0;
  const rest = {
    git: {
      async getRef({ ref }) {
        if (!refs.has(ref))
          throw Object.assign(new Error("not found"), { status: 404 });
        return { data: { ref: `refs/${ref}`, object: { sha: refs.get(ref) } } };
      },
      async createRef({ ref, sha }) {
        const normalized = ref.replace(/^refs\//u, "");
        if (refs.has(normalized))
          throw Object.assign(new Error("exists"), { status: 422 });
        refs.set(normalized, sha);
        return { data: { ref, object: { sha } } };
      },
      async updateRef({ ref, sha }) {
        if (protectedRefs.has(ref))
          throw Object.assign(new Error("protected branch"), { status: 403 });
        refs.set(ref, sha);
        return { data: { ref: `refs/${ref}`, object: { sha } } };
      },
      async getCommit({ commit_sha: sha }) {
        return { data: commits.get(sha) };
      },
      async createBlob({ content }) {
        const sha = digest(content).slice(0, 40);
        blobs.set(sha, Buffer.from(content).toString("base64"));
        return { data: { sha } };
      },
      async createTree({ tree }) {
        const sha = `tree-${trees.size}`;
        trees.set(sha, tree);
        return { data: { sha } };
      },
      async getTree({ tree_sha }) {
        return { data: { tree: trees.get(tree_sha) || [] } };
      },
      async getBlob({ file_sha }) {
        return { data: { content: blobs.get(file_sha), encoding: "base64" } };
      },
      async createCommit({ tree, parents, message }) {
        commitCount += 1;
        const commit = {
          sha: commitCount === 1 ? VERSION_STATE : REBASED_VERSION_STATE,
          tree: { sha: tree },
          parents: parents.map((sha) => ({ sha })),
          message,
        };
        commits.set(commit.sha, commit);
        return { data: commit };
      },
    },
    repos: {
      async compareCommitsWithBasehead({ basehead }) {
        const [ancestor, current] = basehead.split("...");
        const contained =
          ancestor === current ||
          commits.get(current)?.parents?.some(({ sha }) => sha === ancestor);
        return { data: { status: contained ? "ahead" : "diverged" } };
      },
    },
    checks: {
      async create(input) {
        checks.push(input);
      },
    },
    pulls: {
      async list() {
        return { data: pullRequests };
      },
      async create(input) {
        pullRequests.push({ ...input, html_url: "https://example.test/pr/1" });
        return { data: pullRequests.at(-1) };
      },
    },
  };
  return {
    octokit: { rest },
    refs,
    protectedRefs,
    pullRequests,
    checks,
    commits,
    trees,
  };
}

function npmProvider(
  cwd,
  { initialIntegrity = "", visibilityLagReads = 0 } = {},
) {
  let integrity = initialIntegrity;
  let publishCount = 0;
  let remainingVisibilityLagReads = 0;
  return {
    get publishCount() {
      return publishCount;
    },
    spawn(command, args) {
      assert.equal(command, "npm");
      if (args[0] === "pack") {
        const destination = args[args.indexOf("--pack-destination") + 1];
        const filename = "kungfu-tech-buildchain-4.0.2-alpha.7.tgz";
        fs.writeFileSync(
          path.join(destination, filename),
          "rematerialized bytes",
        );
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              name: "@kungfu-tech/buildchain",
              version: "4.0.2-alpha.7",
              filename,
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "view") {
        if (remainingVisibilityLagReads > 0) {
          remainingVisibilityLagReads -= 1;
          return { status: 1, stdout: "", stderr: "npm error E404" };
        }
        return integrity
          ? { status: 0, stdout: JSON.stringify(integrity), stderr: "" }
          : { status: 1, stdout: "", stderr: "npm error E404" };
      }
      if (args[0] === "publish") {
        publishCount += 1;
        remainingVisibilityLagReads = visibilityLagReads;
        integrity = `sha512-${crypto
          .createHash("sha512")
          .update(fs.readFileSync(args[1]))
          .digest("base64")}`;
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected npm command in ${cwd}: ${args.join(" ")}`);
    },
  };
}

function productScenario(files, github, roots = ["6", "7"]) {
  const intent = selectV4ProductPublicationIntent({
    channel: "alpha",
    targetRef: "alpha/v4/v4.0",
    sourceSha: SOURCE,
    sourceTimestamp: "2026-08-30T00:00:00.000Z",
    repository: "kungfu-systems/buildchain",
    packageName: "@kungfu-tech/buildchain",
    distTag: "alpha",
    sealedBundleRoot: files.manifest.root,
    requiredArtifactsRoot: v4ContentRoot(
      "v4-product-required-artifacts",
      files.requiredArtifacts,
    ),
    candidateVersion: "4.0.2-alpha.6",
    observedVersions: ["4.0.2-alpha.6"],
  });
  const plan = createV4ProductPublicationPlan({
    intent,
    invocationRoot: `sha256:${roots[0].repeat(64)}`,
    transactionRoot: `sha256:${roots[1].repeat(64)}`,
  });
  return {
    intent,
    plan,
    effectPlan: compileReleaseTailDeclaration(
      createV4ProductPublicationDeclaration({ intent, plan }),
    ),
    request: {
      octokit: github.octokit,
      mutationOctokit: github.octokit,
      sealedBundleRoot: files.cwd,
      sealedBundleManifest: files.manifestPath,
      requiredArtifactsPath: files.requiredArtifactsPath,
      requiredStatusCheck: "check",
      publishAuth: "trusted-publishing",
      publishPackageSetOrder: "as-provided",
      publishPackageMain: "@kungfu-tech/buildchain",
    },
  };
}

test("unsupported legacy publication inputs fail before provider mutation", () => {
  const files = fixture();
  const github = githubProvider();
  const scenario = productScenario(files, github);
  let spawnCount = 0;
  assert.throws(
    () =>
      createV4ProductPublicationAdapters({
        request: {
          ...scenario.request,
          publishCommand: "pnpm publish --recursive",
        },
        intent: scenario.intent,
        plan: scenario.plan,
        cwd: files.cwd,
        spawn() {
          spawnCount += 1;
          throw new Error("provider command must not run");
        },
      }),
    (error) =>
      error.releaseTailClass === "conflict" &&
      error.releaseTailCode === "unsupported-publish-command",
  );
  assert.equal(spawnCount, 0);
  assert.equal(github.refs.size, 2);
});

test("an existing npm version with different integrity blocks without republishing", async () => {
  const files = fixture();
  const github = githubProvider();
  const npm = npmProvider(files.cwd, {
    initialIntegrity: "sha512-provider-bytes-do-not-match",
  });
  const scenario = productScenario(files, github, ["8", "9"]);
  const runtime = createV4ProductPublicationAdapters({
    request: scenario.request,
    intent: scenario.intent,
    plan: scenario.plan,
    cwd: files.cwd,
    spawn: npm.spawn,
  });
  const result = await executeReleaseTailTransaction(
    createReleaseTailTransaction(scenario.effectPlan),
    { adapters: runtime.adapters },
  );
  assert.equal(result.state, "terminal-failure");
  assert.equal(result.failure.code, "provider-conflict");
  assert.equal(npm.publishCount, 0);
  assert.equal(github.refs.has("tags/v4.0.2-alpha.7"), false);
});

test("rooted product effects publish once and replay entirely from provider readback", async () => {
  const files = fixture();
  const github = githubProvider();
  const npm = npmProvider(files.cwd);
  const intent = selectV4ProductPublicationIntent({
    channel: "alpha",
    targetRef: "alpha/v4/v4.0",
    sourceSha: SOURCE,
    sourceTimestamp: "2026-08-30T00:00:00.000Z",
    repository: "kungfu-systems/buildchain",
    packageName: "@kungfu-tech/buildchain",
    distTag: "alpha",
    sealedBundleRoot: files.manifest.root,
    requiredArtifactsRoot: v4ContentRoot(
      "v4-product-required-artifacts",
      files.requiredArtifacts,
    ),
    candidateVersion: "4.0.2-alpha.6",
    observedVersions: ["4.0.2-alpha.6"],
  });
  const plan = createV4ProductPublicationPlan({
    intent,
    invocationRoot: `sha256:${"2".repeat(64)}`,
    transactionRoot: `sha256:${"3".repeat(64)}`,
  });
  const declaration = createV4ProductPublicationDeclaration({ intent, plan });
  const effectPlan = compileReleaseTailDeclaration(declaration);
  const request = {
    octokit: github.octokit,
    mutationOctokit: github.octokit,
    sealedBundleRoot: files.cwd,
    sealedBundleManifest: files.manifestPath,
    requiredArtifactsPath: files.requiredArtifactsPath,
    requiredStatusCheck: "check",
  };
  const firstRuntime = createV4ProductPublicationAdapters({
    request,
    intent,
    plan,
    cwd: files.cwd,
    spawn: npm.spawn,
  });
  const first = await executeReleaseTailTransaction(
    createReleaseTailTransaction(effectPlan),
    { adapters: firstRuntime.adapters },
  );
  assert.equal(first.state, "complete");
  assert.equal(first.receipts.length, 3);
  assert.equal(npm.publishCount, 1);
  assert.equal(github.refs.get("tags/v4.0.2-alpha.7"), SOURCE);
  assert.equal(github.refs.get("tags/v4-alpha"), VERSION_STATE);
  assert.equal(await firstRuntime.resolveReleaseSha(), VERSION_STATE);

  const replayRuntime = createV4ProductPublicationAdapters({
    request,
    intent,
    plan,
    cwd: files.cwd,
    spawn: npm.spawn,
  });
  const replay = await executeReleaseTailTransaction(
    createReleaseTailTransaction(effectPlan),
    { adapters: replayRuntime.adapters },
  );
  assert.equal(replay.state, "complete");
  assert.equal(
    replay.receipts.every(({ action }) => action === "observed-existing"),
    true,
  );
  assert.equal(npm.publishCount, 1);
});

test("GitHub product mutation retries a transient blob write without republishing npm", async () => {
  const files = fixture();
  const github = githubProvider();
  const npm = npmProvider(files.cwd);
  const scenario = productScenario(files, github, ["c", "d"]);
  const createBlob = github.octokit.rest.git.createBlob;
  let blobAttempts = 0;
  github.octokit.rest.git.createBlob = async (input) => {
    blobAttempts += 1;
    if (blobAttempts === 1)
      throw Object.assign(new Error("upstream reset"), { status: 502 });
    return createBlob(input);
  };
  const waits = [];
  const runtime = createV4ProductPublicationAdapters({
    request: scenario.request,
    intent: scenario.intent,
    plan: scenario.plan,
    cwd: files.cwd,
    spawn: npm.spawn,
    wait(delayMs) {
      waits.push(delayMs);
    },
  });
  const result = await executeReleaseTailTransaction(
    createReleaseTailTransaction(scenario.effectPlan),
    { adapters: runtime.adapters },
  );
  assert.equal(result.state, "complete");
  assert.equal(npm.publishCount, 1);
  assert.deepEqual(waits, [1_000]);
  assert.equal(github.refs.get("tags/v4-alpha"), VERSION_STATE);
});

test("npm publication waits for registry visibility without republishing an immutable version", async () => {
  const files = fixture();
  const github = githubProvider();
  const npm = npmProvider(files.cwd, { visibilityLagReads: 3 });
  const scenario = productScenario(files, github, ["a", "b"]);
  const waits = [];
  const runtime = createV4ProductPublicationAdapters({
    request: scenario.request,
    intent: scenario.intent,
    plan: scenario.plan,
    cwd: files.cwd,
    spawn: npm.spawn,
    wait(delayMs) {
      waits.push(delayMs);
    },
  });
  const result = await executeReleaseTailTransaction(
    createReleaseTailTransaction(scenario.effectPlan),
    { adapters: runtime.adapters },
  );
  assert.equal(result.state, "complete");
  assert.equal(npm.publishCount, 1);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
});

test("protected-ref rejection blocks safely and resumes after PR merge without republishing npm", async () => {
  const files = fixture();
  const github = githubProvider();
  github.protectedRefs.add("heads/alpha/v4/v4.0");
  const createPullRequest = github.octokit.rest.pulls.create;
  let losePullRequestResponse = true;
  github.octokit.rest.pulls.create = async (input) => {
    const result = await createPullRequest(input);
    if (losePullRequestResponse) {
      losePullRequestResponse = false;
      throw Object.assign(new Error("response lost after PR creation"), {
        code: "ECONNRESET",
      });
    }
    return result;
  };
  const npm = npmProvider(files.cwd);
  const intent = selectV4ProductPublicationIntent({
    channel: "alpha",
    targetRef: "alpha/v4/v4.0",
    sourceSha: SOURCE,
    sourceTimestamp: "2026-08-30T00:00:00.000Z",
    repository: "kungfu-systems/buildchain",
    packageName: "@kungfu-tech/buildchain",
    distTag: "alpha",
    sealedBundleRoot: files.manifest.root,
    requiredArtifactsRoot: v4ContentRoot(
      "v4-product-required-artifacts",
      files.requiredArtifacts,
    ),
    candidateVersion: "4.0.2-alpha.6",
    observedVersions: ["4.0.2-alpha.6"],
  });
  const plan = createV4ProductPublicationPlan({
    intent,
    invocationRoot: `sha256:${"4".repeat(64)}`,
    transactionRoot: `sha256:${"5".repeat(64)}`,
  });
  const effectPlan = compileReleaseTailDeclaration(
    createV4ProductPublicationDeclaration({ intent, plan }),
  );
  const request = {
    octokit: github.octokit,
    mutationOctokit: github.octokit,
    sealedBundleRoot: files.cwd,
    sealedBundleManifest: files.manifestPath,
    requiredArtifactsPath: files.requiredArtifactsPath,
    requiredStatusCheck: "check",
  };
  const interruptedRuntime = createV4ProductPublicationAdapters({
    request,
    intent,
    plan,
    cwd: files.cwd,
    spawn: npm.spawn,
  });
  const interrupted = await executeReleaseTailTransaction(
    createReleaseTailTransaction(effectPlan),
    { adapters: interruptedRuntime.adapters },
  );
  assert.equal(interrupted.state, "blocked");
  assert.equal(interrupted.failure.code, "local-retry-exhausted");
  assert.equal(npm.publishCount, 1);
  assert.equal(github.pullRequests.length, 1);
  const pullRequest = github.pullRequests[0];
  assert.match(pullRequest.head, /^chore\/v4-product-pr\//u);
  assert.equal(
    github.refs.get(`heads/${pullRequest.head}`),
    REBASED_VERSION_STATE,
  );
  assert.deepEqual(github.commits.get(REBASED_VERSION_STATE).parents, [
    { sha: SOURCE },
    { sha: VERSION_STATE },
  ]);
  const rebasedTree = github.commits.get(REBASED_VERSION_STATE).tree.sha;
  const releaseStateTree = github.commits.get(VERSION_STATE).tree.sha;
  assert.deepEqual(
    github.trees.get(rebasedTree),
    github.trees.get(releaseStateTree),
  );
  assert.equal(github.checks.at(-1).head_sha, REBASED_VERSION_STATE);
  assert.equal(github.refs.has("tags/v4-alpha"), false);

  github.refs.set("heads/alpha/v4/v4.0", REBASED_VERSION_STATE);
  const resumedRuntime = createV4ProductPublicationAdapters({
    request,
    intent,
    plan,
    cwd: files.cwd,
    spawn: npm.spawn,
  });
  const resumed = await executeReleaseTailTransaction(
    createReleaseTailTransaction(effectPlan),
    { adapters: resumedRuntime.adapters },
  );
  assert.equal(resumed.state, "complete");
  assert.equal(npm.publishCount, 1);
  assert.equal(github.refs.get("tags/v4-alpha"), REBASED_VERSION_STATE);
});
