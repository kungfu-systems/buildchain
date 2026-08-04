// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  classifyDevDelta,
  createGithubEnqueueReceipt,
  createIntegrationDeliveryProof,
  createSourceQualificationProof,
  createSourceReplayReceipt,
  planSourceReplay,
  verifyIntegrationDeliveryProof,
  verifyGithubEnqueueReceipt,
  verifySourceQualificationProof,
  verifySourceReplayReceipt,
} from "../scripts/dev-delivery-proof.mjs";
import { applyDevDeliveryProofOperation } from "../scripts/dev-delivery-proof-cli.mjs";
import { contentRoot } from "../scripts/dev-delivery-warrant-contract.mjs";

const ROOT_A = `sha256:${"a".repeat(64)}`;
const ROOT_B = `sha256:${"b".repeat(64)}`;
const ROOT_C = `sha256:${"c".repeat(64)}`;
const ROOT_D = `sha256:${"d".repeat(64)}`;
const ROOT_E = `sha256:${"e".repeat(64)}`;
const ROOT_F = `sha256:${"f".repeat(64)}`;
const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);
const SHA_C = "3".repeat(40);
const SHA_D = "4".repeat(40);
const T0 = "2026-08-04T00:00:00.000Z";

function sourceProof(overrides = {}) {
  return createSourceQualificationProof({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    pullRequestNumber: 2303,
    sourceHeadSha: SHA_A,
    semanticSourceRoot: ROOT_A,
    sourceIntentRoot: ROOT_B,
    planRoot: ROOT_C,
    affectedClosure: {
      shards: [
        {
          id: "linux-x64",
          pathPrefixes: ["framework/core", "shared/native"],
          qualificationContext: "affected-native / linux-x64",
        },
        {
          id: "macos-arm64",
          pathPrefixes: ["framework/release", "shared/native"],
          qualificationContext: "affected-native / macos-arm64",
        },
      ],
      unrelatedPathPrefixes: ["docs", ".github/ISSUE_TEMPLATE"],
    },
    dependencyGraphRoot: ROOT_D,
    toolchainRoot: ROOT_E,
    requiredContexts: [
      {
        name: "source qualification",
        conclusion: "success",
        headSha: SHA_A,
        evidenceRoot: ROOT_F,
      },
    ],
    evidenceRoots: [ROOT_F],
    ...overrides,
  });
}

function classify(proof, overrides = {}) {
  return classifyDevDelta({
    sourceProof: proof,
    previousBaseSha: SHA_B,
    currentBaseSha: SHA_C,
    changedPaths: ["docs/release-governance.md"],
    dependencyGraphRoot: ROOT_D,
    toolchainRoot: ROOT_E,
    ...overrides,
  });
}

function warrant(overrides = {}) {
  return {
    warrantId: ROOT_A,
    fencingToken: ROOT_B,
    generation: 7,
    submissionId: ROOT_C,
    issuedAt: T0,
    expiresAt: "2026-08-04T01:00:00.000Z",
    ...overrides,
  };
}

function providerReceipt(overrides = {}) {
  const activeWarrant = overrides.warrant || warrant();
  return createGithubEnqueueReceipt({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    submissionId: activeWarrant.submissionId,
    sourceHeadSha: SHA_A,
    warrant: activeWarrant,
    queueEntryId: "MQE_123",
    queueEntryState: "QUEUED",
    recoveredAfterControllerRestart: false,
    queueRevision: ROOT_E,
    ...overrides,
  });
}

test("source qualification proof is canonical, versioned, and content addressed", () => {
  const proof = sourceProof();
  assert.match(proof.sourceProofRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    proof.affectedClosure.shards.map((entry) => entry.id).join(","),
    "linux-x64,macos-arm64",
  );
  assert.equal(
    verifySourceQualificationProof(proof, { sourceHeadSha: SHA_A })
      .sourceProofRoot,
    proof.sourceProofRoot,
  );
  assert.throws(
    () =>
      verifySourceQualificationProof({
        ...proof,
        toolchainRoot: ROOT_F,
      }),
    /sourceProofRoot mismatch/u,
  );
  assert.throws(
    () =>
      sourceProof({
        requiredContexts: [
          {
            name: "source qualification",
            conclusion: "success",
            headSha: SHA_B,
            evidenceRoot: ROOT_F,
          },
        ],
      }),
    /not for the source head/u,
  );
});

test("public dev proof operation verifies roots and CLI discovery exposes the surface", () => {
  const proof = sourceProof();
  const receipt = applyDevDeliveryProofOperation("source-verify", { proof });
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.result.sourceProofRoot, proof.sourceProofRoot);
  assert.match(receipt.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
  const help = spawnSync(
    process.execPath,
    ["bin/buildchain.mjs", "dev", "proof", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /integration-verify/u);
});

test("base-only unrelated movement reuses source qualification without PR-head rewrite", () => {
  const proof = sourceProof();
  const classification = classify(proof);
  assert.equal(classification.mode, "reuse-source-proof");
  assert.equal(classification.reason, "base-only-unrelated-delta");
  assert.equal(classification.sourceProofReusable, true);
  const plan = planSourceReplay({
    sourceProof: proof,
    classification,
    sourceHeadSha: SHA_A,
  });
  assert.equal(plan.action, "replay-on-latest-base");
  assert.equal(plan.physicalPrHeadRewrite, false);
  assert.deepEqual(plan.affectedShards, []);
});

test("overlapping dev delta reruns only the affected closure shards", () => {
  const proof = sourceProof();
  const one = classify(proof, { changedPaths: ["framework/core/src/main.cc"] });
  assert.equal(one.mode, "rerun-affected");
  assert.deepEqual(one.affectedShards, ["linux-x64"]);
  const overlap = classify(proof, { changedPaths: ["shared/native/abi.h"] });
  assert.equal(overlap.mode, "rerun-affected");
  assert.deepEqual(overlap.affectedShards, ["linux-x64", "macos-arm64"]);
  assert.equal(overlap.sourceProofReusable, true);
});

test("unknown attribution and changed dependency or toolchain roots fail closed", () => {
  const proof = sourceProof();
  const unknown = classify(proof, { changedPaths: ["unowned/new-file.txt"] });
  assert.equal(unknown.mode, "rerun-all");
  assert.deepEqual(unknown.unknownPaths, ["unowned/new-file.txt"]);
  assert.equal(unknown.sourceProofReusable, false);
  const missing = classify(proof, { changedPaths: undefined });
  assert.equal(missing.reason, "unknown-attribution");
  const roots = classify(proof, {
    dependencyGraphRoot: ROOT_F,
    toolchainRoot: ROOT_A,
  });
  assert.equal(roots.mode, "rerun-all");
  assert.deepEqual(roots.rootChanges, [
    "dependency-graph-root-changed",
    "toolchain-root-changed",
  ]);
  const forgedBody = {
    ...roots,
    mode: "reuse-source-proof",
    reason: "base-only-unrelated-delta",
    sourceProofReusable: true,
  };
  delete forgedBody.classificationRoot;
  const forged = {
    ...forgedBody,
    classificationRoot: contentRoot(forgedBody),
  };
  assert.throws(
    () =>
      planSourceReplay({
        sourceProof: proof,
        classification: forged,
        sourceHeadSha: SHA_A,
      }),
    /semantic mismatch/u,
  );
});

test("source movement or replay conflict requires explicit repair and never rotates the PR head", () => {
  const proof = sourceProof();
  const classification = classify(proof);
  const changed = planSourceReplay({
    sourceProof: proof,
    classification,
    sourceHeadSha: SHA_D,
  });
  assert.equal(changed.action, "source-repair-required");
  assert.equal(changed.physicalPrHeadRewrite, false);
  const conflict = planSourceReplay({
    sourceProof: proof,
    classification,
    sourceHeadSha: SHA_A,
    conflicts: ["framework/core/src/main.cc"],
  });
  assert.equal(conflict.action, "blocked-conflict");
});

test("source replay receipt binds exact Warrant, queue revision, and candidate tree", () => {
  const proof = sourceProof();
  const classification = classify(proof);
  const plan = planSourceReplay({
    sourceProof: proof,
    classification,
    sourceHeadSha: SHA_A,
  });
  const receipt = createSourceReplayReceipt({
    plan,
    repository: proof.repository,
    protectedBase: proof.protectedBase,
    candidateTreeSha: SHA_D,
    warrant: warrant(),
    queueRevision: ROOT_D,
    replayedAt: "2026-08-04T00:10:00Z",
  });
  assert.equal(receipt.physicalPrHeadRewritten, false);
  assert.equal(
    verifySourceReplayReceipt(receipt, {
      sourceProof: proof,
      classification,
      queueRevision: ROOT_D,
    }).candidateTreeSha,
    SHA_D,
  );
});

test("self-rooted semantic forgeries fail closed at replay and provider boundaries", () => {
  const proof = sourceProof();
  const classification = classify(proof);
  const plan = planSourceReplay({
    sourceProof: proof,
    classification,
    sourceHeadSha: SHA_A,
  });
  const receipt = createSourceReplayReceipt({
    plan,
    repository: proof.repository,
    protectedBase: proof.protectedBase,
    candidateTreeSha: SHA_D,
    warrant: warrant(),
    queueRevision: ROOT_D,
    replayedAt: "2026-08-04T00:10:00Z",
  });
  const forgedPlanBody = {
    ...receipt.replayPlan,
    physicalPrHeadRewrite: true,
  };
  delete forgedPlanBody.replayPlanRoot;
  const forgedPlan = {
    ...forgedPlanBody,
    replayPlanRoot: contentRoot(forgedPlanBody),
  };
  const forgedReceiptBody = {
    ...receipt,
    replayPlan: forgedPlan,
    replayPlanRoot: forgedPlan.replayPlanRoot,
  };
  delete forgedReceiptBody.replayReceiptRoot;
  const forgedReceipt = {
    ...forgedReceiptBody,
    replayReceiptRoot: contentRoot(forgedReceiptBody),
  };
  assert.throws(
    () =>
      verifySourceReplayReceipt(forgedReceipt, {
        sourceProof: proof,
        classification,
      }),
    /semantic mismatch/u,
  );

  const provider = providerReceipt();
  const forgedProviderBody = { ...provider, generation: 8 };
  delete forgedProviderBody.receiptRoot;
  const forgedProvider = {
    ...forgedProviderBody,
    receiptRoot: contentRoot(forgedProviderBody),
  };
  assert.throws(
    () =>
      verifyGithubEnqueueReceipt(forgedProvider, {
        repository: proof.repository,
        protectedBase: proof.protectedBase,
        submissionId: warrant().submissionId,
        sourceHeadSha: proof.sourceHeadSha,
        warrant: warrant(),
        queueRevision: ROOT_E,
      }),
    /not canonical/u,
  );
});

test("integration proof binds every successful context to the exact merge-group tree", () => {
  const proof = sourceProof();
  const classification = classify(proof);
  const plan = planSourceReplay({
    sourceProof: proof,
    classification,
    sourceHeadSha: SHA_A,
  });
  const replay = createSourceReplayReceipt({
    plan,
    repository: proof.repository,
    protectedBase: proof.protectedBase,
    candidateTreeSha: SHA_D,
    warrant: warrant(),
    queueRevision: ROOT_D,
    replayedAt: "2026-08-04T00:10:00Z",
  });
  const integration = createIntegrationDeliveryProof({
    repository: proof.repository,
    protectedBase: proof.protectedBase,
    sourceProofRoot: proof.sourceProofRoot,
    replayReceiptRoot: replay.replayReceiptRoot,
    classificationRoot: classification.classificationRoot,
    integrationTreeSha: SHA_D,
    protectedBaseSha: SHA_C,
    warrant: warrant(),
    queueRevision: ROOT_E,
    providerReceipt: providerReceipt(),
    requiredContexts: [
      {
        name: "affected-native / linux-x64",
        conclusion: "success",
        headSha: SHA_D,
        evidenceRoot: ROOT_A,
      },
      {
        name: "queue-admission",
        conclusion: "success",
        headSha: SHA_D,
        evidenceRoot: ROOT_B,
      },
    ],
    verifiedAt: "2026-08-04T00:40:00Z",
  });
  assert.equal(
    verifyIntegrationDeliveryProof(integration, {
      integrationTreeSha: SHA_D,
      sourceProofRoot: proof.sourceProofRoot,
      providerReceipt: providerReceipt(),
    }).integrationProofRoot,
    integration.integrationProofRoot,
  );
  assert.throws(
    () =>
      createIntegrationDeliveryProof({
        ...integration,
        integrationProofRoot: undefined,
        providerReceipt: providerReceipt(),
        requiredContexts: [
          {
            name: "queue-admission",
            conclusion: "success",
            headSha: SHA_C,
            evidenceRoot: ROOT_B,
          },
        ],
      }),
    /not for the integration tree/u,
  );
});

test("expired Warrant and failed required contexts cannot forge integration proof", () => {
  const proof = sourceProof();
  assert.throws(
    () =>
      createIntegrationDeliveryProof({
        repository: proof.repository,
        protectedBase: proof.protectedBase,
        sourceProofRoot: proof.sourceProofRoot,
        replayReceiptRoot: ROOT_A,
        classificationRoot: ROOT_B,
        integrationTreeSha: SHA_D,
        protectedBaseSha: SHA_C,
        warrant: warrant(),
        queueRevision: ROOT_D,
        providerReceipt: providerReceipt({ queueRevision: ROOT_D }),
        requiredContexts: [
          {
            name: "queue-admission",
            conclusion: "failure",
            headSha: SHA_D,
            evidenceRoot: ROOT_F,
          },
        ],
        verifiedAt: "2026-08-04T01:00:00Z",
      }),
    /after Warrant expiry|did not succeed/u,
  );
});
