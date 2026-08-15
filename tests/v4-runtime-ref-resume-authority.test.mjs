import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  authorizeV4RuntimeSelection,
  createV4RuntimeResumeLineage,
  scanV4RuntimeSelectorPersistence,
  v4RuntimeResumeDocumentRoot,
  verifyV4RuntimeAuthorizationReceipt,
  verifyV4RuntimeResumeLineage,
} from "../packages/core/v4-runtime-ref-resume-authority.js";
import { createReleasePassport } from "../packages/core/release-passport.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SOURCE_SHA = "c".repeat(40);
const TREE_SHA = "d".repeat(40);
const ROOT_A = `sha256:${"a".repeat(64)}`;
const ROOT_B = `sha256:${"b".repeat(64)}`;
const ROOT_C = `sha256:${"c".repeat(64)}`;
const ROOT_D = `sha256:${"d".repeat(64)}`;
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const evidenceSchema = JSON.parse(
  fs.readFileSync(
    path.join(
      repositoryRoot,
      "contracts/v4-runtime-ref-resume-authority-v1.schema.json",
    ),
    "utf8",
  ),
);
const scenario = JSON.parse(
  fs.readFileSync(
    path.join(
      repositoryRoot,
      "contracts/fixtures/v4-runtime-ref-resume-authority-v1/scenario.json",
    ),
    "utf8",
  ),
);

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function cleanConsumer() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-runtime-authority-"),
  );
  write(
    path.join(root, ".github/workflows/release.yml"),
    `on:\n  workflow_dispatch:\n    inputs:\n      buildchain-ref:\n        default: ""\npermissions:\n  id-token: write\njobs:\n  release:\n    uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v4-alpha\n    with:\n      buildchain-ref: \${{ inputs.buildchain-ref }}\n`,
  );
  write(
    path.join(root, ".buildchain/contract-lock.json"),
    `${JSON.stringify({ resolvedSha: SHA_A })}\n`,
  );
  write(
    path.join(root, ".buildchain/alpha-contract-lock.json"),
    `${JSON.stringify({ resolvedSha: SHA_B })}\n`,
  );
  return root;
}

function authorize({
  scan = scanV4RuntimeSelectorPersistence({ root: cleanConsumer() }),
  ...overrides
} = {}) {
  return authorizeV4RuntimeSelection({
    repository: "kungfu-systems/consumer",
    eventName: "workflow_dispatch",
    mode: "resume",
    actor: "maintainer",
    actorPermission: "maintain",
    reason: "resume a failed platform tail with a repaired v4 runtime",
    authorizedAt: "2026-08-14T02:00:00.000Z",
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    requestedRef: SHA_B,
    resolvedRuntimeSha: SHA_B,
    approvedRefReadbacks: [
      {
        ref: "train/v4/v4.0/runtime-rescue",
        sha: SHA_B,
        containsRuntimeSha: true,
        readbackRoot: ROOT_A,
      },
      {
        ref: "v4-alpha",
        sha: SHA_A,
        containsRuntimeSha: false,
        readbackRoot: ROOT_B,
      },
    ],
    stableContractLockRoot: ROOT_A,
    alphaContractLockRoot: ROOT_B,
    consumerPolicyReceiptRoot: ROOT_C,
    persistenceScan: scan,
    ...overrides,
  });
}

function capsule(platform) {
  return {
    platform,
    capsuleRoot: ROOT_A,
    identityRoot: ROOT_B,
    artifactDigest: ROOT_D,
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    policyRoot: ROOT_C,
    buildRuntimeSha: SHA_A,
    sealed: true,
  };
}

test("source scan records OIDC and rejects selectors persisted outside uses nodes", () => {
  const root = cleanConsumer();
  const clean = scanV4RuntimeSelectorPersistence({ root });
  assert.equal(clean.status, "passed");
  assert.deepEqual(clean.failures, []);
  assert.ok(clean.authorityUsage.some((entry) => entry.class === "oidc"));
  assert.equal(
    clean.root,
    v4RuntimeResumeDocumentRoot((({ root: _root, ...value }) => value)(clean)),
  );

  write(
    path.join(root, ".buildchain/release-runtime.toml"),
    `buildchain_runtime_sha = "${SHA_B}"\n`,
  );
  write(
    path.join(root, ".buildchain/runtime.json"),
    `${JSON.stringify({ buildchainRuntime: { sha: SHA_B } }, null, 2)}\n`,
  );
  write(
    path.join(root, ".github/actions/runtime/action.yml"),
    "name: runtime\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      env:\n        BUILDCHAIN_RUNTIME_SHA: ${{ vars.BUILDCHAIN_RUNTIME_SHA }}\n      run: echo runtime\n",
  );
  const rejected = scanV4RuntimeSelectorPersistence({ root });
  assert.equal(rejected.status, "rejected");
  assert.ok(
    rejected.failures.some(
      (failure) => failure.code === "persistent-runtime-exact-sha",
    ),
  );
  assert.ok(
    rejected.failures.some(
      (failure) => failure.code === "persistent-runtime-external-indirection",
    ),
  );
  assert.ok(
    rejected.failures.some(
      (failure) => failure.code === "persistent-runtime-json-value",
    ),
  );
});

test("trusted exact runtime authorization binds reachability, actor, reason, locks, and source cut", () => {
  const result = authorize();
  assert.equal(result.receipt.status, "authorized");
  assert.equal(result.receipt.request.class, "exact-sha");
  assert.equal(result.receipt.runtime.sha, SHA_B);
  assert.deepEqual(
    result.receipt.runtime.reachableFrom.map((entry) => entry.ref),
    ["train/v4/v4.0/runtime-rescue", "v4-alpha"],
  );
  assert.equal(
    verifyV4RuntimeAuthorizationReceipt({
      receipt: result.receipt,
      receiptRoot: result.receiptRoot,
      repository: "kungfu-systems/consumer",
      sourceSha: SOURCE_SHA,
      runtimeSha: SHA_B,
      consumerPolicyReceiptRoot: ROOT_C,
    }).ok,
    true,
  );
});

test("runtime authorization fails closed on event, permission, reachability, stale roots, and persistence", () => {
  assert.throws(
    () => authorize({ eventName: "pull_request" }),
    /only allowed for trusted workflow_dispatch/u,
  );
  assert.throws(
    () => authorize({ actorPermission: "read" }),
    /requires write, maintain, or admin/u,
  );
  assert.throws(
    () =>
      authorize({
        approvedRefReadbacks: [
          {
            ref: "v4-alpha",
            sha: SHA_A,
            containsRuntimeSha: false,
            readbackRoot: ROOT_A,
          },
        ],
      }),
    /not reachable/u,
  );
  assert.throws(
    () => authorize({ consumerPolicyReceiptRoot: "stale" }),
    /must be a sha256 content root/u,
  );
  const failedScan = scanV4RuntimeSelectorPersistence({
    root: cleanConsumer(),
  });
  failedScan.status = "rejected";
  failedScan.failures = [{ code: "persistent-runtime-default" }];
  failedScan.root = v4RuntimeResumeDocumentRoot(
    (({ root: _root, ...value }) => value)(failedScan),
  );
  assert.throws(
    () => authorize({ scan: failedScan }),
    /persistence scan must pass/u,
  );
});

test("new attempt reuses sealed capsules across a moved floating ref and rebuilds only the missing platform", () => {
  const authorization = authorize();
  const result = createV4RuntimeResumeLineage({
    authorization: authorization.receipt,
    authorizationRoot: authorization.receiptRoot,
    buildAttempt: { id: "attempt-build-17", runtimeSha: SHA_A },
    resumeAttempt: { id: "attempt-resume-18", runtimeSha: SHA_B },
    source: { sha: SOURCE_SHA, treeSha: TREE_SHA },
    consumerPolicyReceiptRoot: ROOT_C,
    requiredPlatforms: ["linux-x64", "macos-arm64", "windows-x64"],
    stageCapsules: [capsule("linux-x64"), capsule("macos-arm64")],
    resumePlanRoot: ROOT_A,
    finalPublicReadbackRoot: ROOT_B,
    floatingRefBefore: { ref: "v4-alpha", sha: SHA_A },
    floatingRefAfter: { ref: "v4-alpha", sha: SHA_B },
  });
  assert.deepEqual(
    result.lineage.stageCapsules.reused.map((entry) => entry.platform),
    ["linux-x64", "macos-arm64"],
  );
  assert.deepEqual(result.lineage.stageCapsules.rebuildPlatforms, [
    "windows-x64",
  ]);
  assert.equal(result.lineage.continuation.rerunFailedJobs, false);
  assert.equal(result.lineage.attempts.build.runtimeSha, SHA_A);
  assert.equal(result.lineage.attempts.resume.runtimeSha, SHA_B);
  assert.equal(
    verifyV4RuntimeResumeLineage({
      lineage: result.lineage,
      lineageRoot: result.lineageRoot,
      sourceSha: SOURCE_SHA,
      buildRuntimeSha: SHA_A,
      resumeRuntimeSha: SHA_B,
      consumerPolicyReceiptRoot: ROOT_C,
    }).ok,
    true,
  );
});

test("resume lineage rejects same-attempt replay and stale capsule identity", () => {
  const authorization = authorize();
  const base = {
    authorization: authorization.receipt,
    authorizationRoot: authorization.receiptRoot,
    buildAttempt: { id: "attempt-17", runtimeSha: SHA_A },
    resumeAttempt: { id: "attempt-17", runtimeSha: SHA_B },
    source: { sha: SOURCE_SHA, treeSha: TREE_SHA },
    consumerPolicyReceiptRoot: ROOT_C,
    requiredPlatforms: ["linux-x64"],
    stageCapsules: [capsule("linux-x64")],
    resumePlanRoot: ROOT_A,
    finalPublicReadbackRoot: ROOT_B,
    floatingRefBefore: { ref: "v4", sha: SHA_A },
    floatingRefAfter: { ref: "v4", sha: SHA_B },
  };
  assert.throws(
    () => createV4RuntimeResumeLineage(base),
    /new governed attempt/u,
  );
  const stale = structuredClone(base);
  stale.resumeAttempt.id = "attempt-18";
  stale.stageCapsules[0].sourceTreeSha = "e".repeat(40);
  assert.throws(
    () => createV4RuntimeResumeLineage(stale),
    /identity is stale or ambiguous/u,
  );
});

test("Release Passport embeds and revalidates runtime A+B Stage Capsule lineage", () => {
  const authorization = authorize();
  const resume = createV4RuntimeResumeLineage({
    authorization: authorization.receipt,
    authorizationRoot: authorization.receiptRoot,
    buildAttempt: { id: "attempt-build-17", runtimeSha: SHA_A },
    resumeAttempt: { id: "attempt-resume-18", runtimeSha: SHA_B },
    source: { sha: SOURCE_SHA, treeSha: TREE_SHA },
    consumerPolicyReceiptRoot: ROOT_C,
    requiredPlatforms: scenario.requiredPlatforms,
    stageCapsules: [capsule("linux-x64"), capsule("macos-arm64")],
    resumePlanRoot: ROOT_A,
    finalPublicReadbackRoot: ROOT_B,
    floatingRefBefore: { ref: "v4-alpha", sha: SHA_A },
    floatingRefAfter: { ref: "v4-alpha", sha: SHA_B },
  });
  const evidence = {
    authorization: authorization.receipt,
    authorizationRoot: authorization.receiptRoot,
    lineage: resume.lineage,
    lineageRoot: resume.lineageRoot,
  };
  const validate = new Ajv2020({ strict: false }).compile(evidenceSchema);
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  const extraAuthorizationField = structuredClone(evidence);
  extraAuthorizationField.authorization.actor.unexpected = true;
  assert.equal(validate(extraAuthorizationField), false);
  const extraLineageField = structuredClone(evidence);
  extraLineageField.lineage.continuation.unexpected = true;
  assert.equal(validate(extraLineageField), false);
  assert.deepEqual(
    resume.lineage.stageCapsules.reused.map((entry) => entry.platform),
    scenario.reusedPlatforms,
  );
  assert.deepEqual(
    resume.lineage.stageCapsules.rebuildPlatforms,
    scenario.rebuildPlatforms,
  );
  const passport = createReleasePassport({
    repository: "kungfu-systems/consumer",
    tag: "v1.0.0",
    sourceSha: SOURCE_SHA,
    v4RuntimeResumeEvidence: evidence,
  });
  assert.equal(
    passport.v4RuntimeResume.lineage.attempts.build.runtimeSha,
    SHA_A,
  );
  assert.equal(
    passport.v4RuntimeResume.lineage.attempts.resume.runtimeSha,
    SHA_B,
  );
  assert.equal(passport.v4RuntimeResume.lineageRoot, resume.lineageRoot);

  const tampered = structuredClone(evidence);
  tampered.lineage.attempts.resume.runtimeSha = "e".repeat(40);
  assert.throws(
    () =>
      createReleasePassport({
        repository: "kungfu-systems/consumer",
        tag: "v1.0.0",
        sourceSha: SOURCE_SHA,
        v4RuntimeResumeEvidence: tampered,
      }),
    /lineage invalid: lineage-root-mismatch/u,
  );
});

test("machine architecture keeps transient authority bounded to v4", () => {
  const architecture = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        "architecture/v4-runtime-ref-resume-authority.json",
      ),
      "utf8",
    ),
  );
  assert.equal(architecture.mode, "v4-only");
  assert.equal(
    architecture.transientSelection.trustedEvent,
    "workflow_dispatch",
  );
  assert.equal(architecture.persistence.exactShaDefault, "deny");
  assert.equal(architecture.resume.failedJobRerun, false);
  assert.equal(architecture.authority.v3BehaviorChange, false);
  assert.equal(architecture.authority.credentialsInEvidence, false);
});
