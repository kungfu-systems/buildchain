import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { devDeliveryContentRoot } from "../packages/core/dev-delivery/dev-delivery-common.js";
import { createSourceQualificationProof } from "../packages/core/dev-delivery/dev-delivery-proof.js";
import {
  pathsAtQualifiedSource,
  qualifiedRunBase,
  sourceProofPaths,
} from "../packages/core/dev-delivery/nodes/source-paths.mjs";
import { successorDispatchPayload } from "../packages/core/dev-delivery/nodes/terminal-settlement.mjs";

test("successor wake carries exact source coordinates without an oversized path array", () => {
  const wake = {
    sourceWorkflowRunId: 123,
    sourceHead: "a".repeat(40),
    affectedPaths: Array.from(
      { length: 2000 },
      (_, i) => `long-responsibility-owned-module-path-${i}.js`,
    ),
  };
  assert.ok(JSON.stringify(wake).length > 65535);
  const payload = successorDispatchPayload(wake);
  assert.equal(payload.client_payload.candidate.sourceWorkflowRunId, 123);
  assert.equal(payload.client_payload.candidate.sourceHead, wake.sourceHead);
  assert.deepEqual(payload.client_payload.candidate.affectedPaths, []);
  assert.equal(wake.affectedPaths.length, 2000);
  assert.throws(
    () => successorDispatchPayload({ ...wake, sourceWorkflowRunId: 0 }),
    /provider payload limit/u,
  );
});

test("source paths reconstruct a large rename and deletion from the exact qualified Git identity", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-large-source-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
    }).trim();
  const commit = (message) =>
    git(
      "-c",
      "user.name=Buildchain Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      message,
    );
  git("init", "--quiet");
  fs.writeFileSync(path.join(directory, "removed.js"), "old\n");
  git("add", ".");
  commit("base");
  const base = git("rev-parse", "HEAD");
  fs.renameSync(
    path.join(directory, "removed.js"),
    path.join(directory, "renamed.js"),
  );
  const added = Array.from(
    { length: 1400 },
    (_, index) =>
      `source-owned-responsibility-with-a-long-file-name-${index}.js`,
  );
  for (const file of added)
    fs.writeFileSync(path.join(directory, file), "export {};\n");
  git("add", ".");
  commit("large source change");
  const env = {
    GITHUB_REPOSITORY: "kungfu-systems/buildchain",
    TARGET_BRANCH: "dev/v4/v4.1",
    EXPECTED_HEAD: git("rev-parse", "HEAD"),
  };
  env.SOURCE_IDENTITY_ROOT = devDeliveryContentRoot({
    schema: "kungfu.buildchain.source-identity/v1",
    repository: env.GITHUB_REPOSITORY,
    protectedBase: env.TARGET_BRANCH,
    qualifiedBase: base,
    sourceHead: env.EXPECTED_HEAD,
    sourceTree: git("rev-parse", "HEAD^{tree}"),
  });
  const actual = pathsAtQualifiedSource(directory, base, env);
  assert.deepEqual(actual, [...added, "removed.js", "renamed.js"].sort());
  assert.ok(JSON.stringify(actual).length > 65535);
  assert.throws(
    () =>
      pathsAtQualifiedSource(directory, base, {
        ...env,
        SOURCE_IDENTITY_ROOT: `sha256:${"0".repeat(64)}`,
      }),
    /source identity root drift/u,
  );
});

test("path reconstruction rejects failed runs and another PR or head", () => {
  const env = { EXPECTED_PR: "7", EXPECTED_HEAD: "a".repeat(40) };
  const run = {
    conclusion: "success",
    event: "pull_request",
    head_sha: env.EXPECTED_HEAD,
    pull_requests: [{ number: 7, base: { sha: "b".repeat(40) } }],
  };
  assert.equal(qualifiedRunBase(run, env), "b".repeat(40));
  for (const invalid of [
    { ...run, conclusion: "failure" },
    { ...run, head_sha: "c".repeat(40) },
    { ...run, pull_requests: [] },
  ])
    assert.throws(
      () => qualifiedRunBase(invalid, env),
      /successful source run/u,
    );
});

test("later nodes recover omitted paths only from an exact untampered source proof", () => {
  const root = `sha256:${"1".repeat(64)}`;
  const proof = createSourceQualificationProof({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v4/v4.1",
    sourceHead: "a".repeat(40),
    sourceIdentityRoot: root,
    sourcePatchRoot: root,
    planRoot: root,
    closureRoot: root,
    dependencyRoot: root,
    toolchainRoot: root,
    affectedPaths: ["removed.js", "renamed.js"],
    shardEvidenceRoots: [root],
    qualifiedAt: "2026-09-09T18:00:00Z",
  });
  const env = {
    AFFECTED_PATHS: "[]",
    GITHUB_REPOSITORY: proof.repository,
    TARGET_BRANCH: proof.protectedBase,
    EXPECTED_HEAD: proof.sourceHead,
    SOURCE_IDENTITY_ROOT: root,
    SOURCE_PROOF_ROOT: proof.proofRoot,
  };
  assert.deepEqual(
    JSON.parse(sourceProofPaths(env, () => proof)),
    proof.affectedPaths,
  );
  const resealed = createSourceQualificationProof({
    ...proof,
    affectedPaths: ["omitted.js"],
  });
  assert.throws(
    () => sourceProofPaths(env, () => resealed),
    /admitted source proof root/u,
  );
  assert.throws(
    () =>
      sourceProofPaths(env, () => ({
        ...proof,
        affectedPaths: ["omitted.js"],
      })),
    /proof-root-drift/u,
  );
  assert.throws(
    () =>
      sourceProofPaths({ ...env, EXPECTED_HEAD: "b".repeat(40) }, () => proof),
    /sourceHead-mismatch/u,
  );
});
