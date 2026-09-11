import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProductPublicationAdapters } from "../packages/core/release/promote-candidate/product-provider-adapters.js";
import {
  PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
  publicationArtifactCandidateDigest,
} from "../packages/core/publication/publication-artifact-candidate.js";
import { createPublicationSealedBundle } from "../packages/core/publication/publication-sealed-bundle.js";
import {
  createReleaseTailTransaction,
  executeReleaseTailTransaction,
} from "../packages/core/release/release-tail-provider-plane.js";
import { domainContentRoot } from "../packages/core/contracts/canonical-contracts.js";
import {
  createProductPublicationDeclaration,
  createProductPublicationPlan,
  selectProductPublicationIntent,
} from "../packages/core/release/product-publication.js";
import { compileReleaseTailDeclaration } from "../packages/core/release/release-tail-provider-plane.js";

import { SOURCE, VERSION_STATE, REBASED_VERSION_STATE, digest, fixture, githubProvider, npmProvider, productScenario } from "./helpers/product-provider-fixtures.mjs";

test("unsupported legacy publication inputs fail before provider mutation", () => {
  const files = fixture();
  const github = githubProvider();
  const scenario = productScenario(files, github);
  let spawnCount = 0;
  assert.throws(
    () =>
      createProductPublicationAdapters({
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
  const runtime = createProductPublicationAdapters({
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
  assert.equal(github.refs.has("tags/v4.0.2-alpha.6"), false);
});

test("rooted product effects publish once and replay entirely from provider readback", async () => {
  const files = fixture();
  const github = githubProvider();
  const npm = npmProvider(files.cwd);
  const intent = selectProductPublicationIntent({
    channel: "alpha",
    targetRef: "alpha/v4/v4.0",
    sourceSha: SOURCE,
    sourceTimestamp: "2026-08-30T00:00:00.000Z",
    repository: "kungfu-systems/buildchain",
    packageName: "@kungfu-tech/buildchain",
    distTag: "alpha",
    sealedBundleRoot: files.manifest.root,
    requiredArtifactsRoot: domainContentRoot("v4-product-required-artifacts", files.requiredArtifacts),
    candidateVersion: "4.0.2-alpha.6",
    observedVersions: ["4.0.2-alpha.6"],
  });
  const plan = createProductPublicationPlan({
    intent,
    invocationRoot: `sha256:${"2".repeat(64)}`,
    transactionRoot: `sha256:${"3".repeat(64)}`,
  });
  const declaration = createProductPublicationDeclaration({ intent, plan });
  const effectPlan = compileReleaseTailDeclaration(declaration);
  const request = {
    octokit: github.octokit,
    mutationOctokit: github.octokit,
    sealedBundleRoot: files.cwd,
    sealedBundleManifest: files.manifestPath,
    requiredArtifactsPath: files.requiredArtifactsPath,
    requiredStatusCheck: "check",
  };
  const firstRuntime = createProductPublicationAdapters({
    request,
    intent,
    plan,
    cwd: files.cwd,
    spawn: npm.spawn,
  });
  const first = await executeReleaseTailTransaction(createReleaseTailTransaction(effectPlan), {
    adapters: firstRuntime.adapters,
  });
  assert.equal(first.state, "complete");
  assert.equal(first.receipts.length, 3);
  assert.equal(npm.publishCount, 1);
  assert.equal(npm.packCount, 0);
  assert.equal(github.refs.get("tags/v4.0.2-alpha.6"), SOURCE);
  assert.equal(github.refs.get("tags/v4-alpha"), SOURCE);
  assert.equal(await firstRuntime.resolveReleaseSha(), SOURCE);
  assert.equal(github.commits.size, 1);

  const replayRuntime = createProductPublicationAdapters({
    request,
    intent,
    plan,
    cwd: files.cwd,
    spawn: npm.spawn,
  });
  const replay = await executeReleaseTailTransaction(createReleaseTailTransaction(effectPlan), {
    adapters: replayRuntime.adapters,
  });
  assert.equal(replay.state, "complete");
  assert.equal(
    replay.receipts.every(({ action }) => action === "observed-existing"),
    true,
  );
  assert.equal(npm.publishCount, 1);
});

test("alpha publishes the sealed tarball without rematerializing package or Git state", async () => {
  const files = fixture();
  const github = githubProvider();
  const npm = npmProvider(files.cwd);
  const scenario = productScenario(files, github, ["c", "d"]);
  let blobAttempts = 0;
  github.octokit.rest.git.createBlob = async () => {
    blobAttempts += 1;
    throw new Error("alpha must not create version-state blobs");
  };
  const waits = [];
  const runtime = createProductPublicationAdapters({
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
  assert.equal(npm.packCount, 0);
  assert.equal(blobAttempts, 0);
  assert.deepEqual(waits, []);
  assert.equal(github.refs.get("tags/v4-alpha"), SOURCE);
});

test("npm publication waits for registry visibility without republishing an immutable version", async () => {
  const files = fixture();
  const github = githubProvider();
  const npm = npmProvider(files.cwd, { visibilityLagReads: 3 });
  const scenario = productScenario(files, github, ["a", "b"]);
  const waits = [];
  const runtime = createProductPublicationAdapters({
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

test("alpha refuses an unreviewed channel ref instead of creating another release PR", async () => {
  const files = fixture();
  const github = githubProvider();
  github.refs.set("heads/alpha/v4/v4.0", "9".repeat(40));
  const npm = npmProvider(files.cwd);
  const scenario = productScenario(files, github, ["4", "5"]);
  const runtime = createProductPublicationAdapters({
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
  assert.equal(result.failure.code, "alpha-candidate-ref-not-converged");
  assert.equal(npm.publishCount, 1);
  assert.equal(github.pullRequests.length, 0);
  assert.equal(github.refs.has("tags/v4-alpha"), false);
});

function packageSetFixture() {
  const files = fixture();
  const packages = [
    { name: "@kungfu-tech/buildchain", role: "main" },
    { name: "@kungfu-tech/buildchain-linux-x64", role: "platform" },
    { name: "@kungfu-tech/buildchain-darwin-arm64", role: "platform" },
  ].map((entry, index) => {
    const relative = `sealed/package-${index}.tgz`;
    const staging = path.join(files.cwd, "pack", String(index));
    fs.mkdirSync(path.join(staging, "package"), { recursive: true });
    const version = "4.0.2-alpha.6";
    fs.writeFileSync(
      path.join(staging, "package/package.json"),
      JSON.stringify({ name: entry.name, version }),
    );
    execFileSync("tar", ["-czf", relative, "-C", path.relative(files.cwd, staging), "package"], { cwd: files.cwd });
    const bytes = fs.readFileSync(path.join(files.cwd, relative));
    return {
      ...entry,
      version,
      path: relative,
      size: bytes.length,
      sha256: digest(bytes),
      integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
    };
  });
  const { candidateDigest: _ignored, ...payload } = files.manifest.candidate;
  payload.files = packages.map(({ path, size, sha256 }) => ({
    path,
    size,
    sha256,
  }));
  payload.npmPackages = packages;
  const candidate = {
    ...payload,
    candidateDigest: publicationArtifactCandidateDigest(payload),
  };
  files.manifest = createPublicationSealedBundle({
    candidate,
    packageName: packages[0].name,
    packageVersion: packages[0].version,
    npmTarballPath: packages[0].path,
    npmIntegrity: packages[0].integrity,
    releaseAssetPaths: packages.map(({ path }) => path),
  });
  files.requiredArtifacts = packages.map(({ name, version, role, integrity }) => ({
    kind: "npm",
    name,
    ref: version,
    role,
    integrity,
    required: true,
  }));
  fs.writeFileSync(files.manifestPath, JSON.stringify(files.manifest));
  fs.writeFileSync(files.requiredArtifactsPath, JSON.stringify(files.requiredArtifacts));
  return { ...files, packages };
}

test("sealed package sets recover after a platform publish without republishing or advancing main early", async () => {
  const files = packageSetFixture();
  const github = githubProvider();
  const scenario = productScenario(files, github, ["4", "5"], {
    npmPackages: files.packages.map((entry) => ({
      ...entry,
      sha256: `sha256:${entry.sha256}`,
    })),
  });
  scenario.request.publishPackageSetOrder = "platforms-first-main-last";
  const published = new Map();
  const calls = [];
  let interrupt = true;
  const spawn = (command, args) => {
    assert.equal(command, "npm");
    if (args[0] === "view")
      return published.has(args[1])
        ? { status: 0, stdout: JSON.stringify(published.get(args[1])) }
        : { status: 1, stderr: "E404" };
    assert.equal(args[0], "publish");
    const entry = files.packages.find((entry) => path.join(files.cwd, entry.path) === args[1]);
    if (interrupt && calls.length === 1)
      return { status: 1, stderr: "simulated provider interruption" };
    calls.push(entry.name);
    published.set(`${entry.name}@${entry.version}`, entry.integrity);
    return { status: 0 };
  };
  const runtime = () =>
    createProductPublicationAdapters({
      ...scenario,
      cwd: files.cwd,
      spawn,
      wait: async () => {},
    });
  const first = await executeReleaseTailTransaction(
    createReleaseTailTransaction(scenario.effectPlan),
    { adapters: runtime().adapters },
  );
  assert.notEqual(first.state, "complete");
  assert.deepEqual(calls, ["@kungfu-tech/buildchain-darwin-arm64"]);
  assert.equal(github.refs.has("tags/v4.0.2-alpha.6"), false);
  interrupt = false;
  const resumed = await executeReleaseTailTransaction(
    createReleaseTailTransaction(scenario.effectPlan),
    { adapters: runtime().adapters },
  );
  assert.equal(resumed.state, "complete");
  assert.equal(resumed.receipts.length, 5);
  assert.deepEqual(calls, [
    "@kungfu-tech/buildchain-darwin-arm64",
    "@kungfu-tech/buildchain-linux-x64",
    "@kungfu-tech/buildchain",
  ]);
  assert.equal(resumed.receipts[1].action, "observed-existing");
  await executeReleaseTailTransaction(createReleaseTailTransaction(scenario.effectPlan), {
    adapters: runtime().adapters,
  });
  assert.equal(calls.length, 3);
});

test("sealed package set inventory and byte drift fail before any provider call", () => {
  const files = packageSetFixture();
  const github = githubProvider();
  const scenario = productScenario(files, github, ["4", "5"], {
    npmPackages: files.packages.map((entry) => ({
      ...entry,
      sha256: `sha256:${entry.sha256}`,
    })),
  });
  let calls = 0;
  const runtime = () =>
    createProductPublicationAdapters({
      ...scenario,
      cwd: files.cwd,
      spawn: () => {
        calls++;
        throw new Error("unexpected provider effect");
      },
    });
  fs.appendFileSync(path.join(files.cwd, files.packages[1].path), "tampered");
  assert.throws(runtime, /file mismatch/u);
  assert.equal(calls, 0);
  assert.equal(github.refs.size, 2);
});
