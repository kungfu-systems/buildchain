// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  runReleaseTrainSelfDogfoodCampaign,
  validateReleaseTrainSelfDogfoodCampaign,
} from "../scripts/release-train-self-dogfood.mjs";

const SHA = (digit) => digit.repeat(40);
const ROOT = (digit) => `sha256:${digit.repeat(64)}`;

function fixture(overrides = {}) {
  return {
    repository: "kungfu-systems/buildchain",
    sourceBranch: "dev/v3/v3.0",
    targetBranch: "alpha/v3/v3.0",
    assignmentRoot: ROOT("1"),
    initiativeRoot: ROOT("2"),
    dependencyProofRoot: ROOT("3"),
    originDevSha: SHA("1"),
    candidateSha: SHA("2"),
    candidateTreeSha: SHA("3"),
    alphaBaseSha: SHA("4"),
    buildchainRuntimeSha: SHA("5"),
    observedDevSha: SHA("6"),
    blockerRoot: ROOT("4"),
    patchRoot: ROOT("5"),
    cutCandidateSha: SHA("7"),
    cutCandidateTreeSha: SHA("8"),
    cutLandingEvidenceRoot: ROOT("6"),
    devBaseSha: SHA("6"),
    devLandingSha: SHA("7"),
    devConflictEvidenceRoot: ROOT("7"),
    devLandingEvidenceRoot: ROOT("8"),
    ordinaryPullRequestNumber: 2547,
    recordedAt: "2026-08-11T03:30:00.000Z",
    delivery: {
      pullRequestNumber: 2550,
      baseBranch: "dev/v3/v3.0",
      headSha: SHA("7"),
      headTreeSha: SHA("8"),
      state: "MERGED",
      reviewState: "APPROVED",
      reviewHeadSha: SHA("7"),
      mergeSha: SHA("9"),
      mergeTreeSha: SHA("8"),
      ciHeadSha: SHA("9"),
      ciConclusion: "success",
      reviewRoot: ROOT("9"),
      ciRoot: ROOT("a"),
      mergeRoot: ROOT("b"),
      artifactRoot: ROOT("c"),
      installedProductRoot: ROOT("d"),
    },
    ...overrides,
  };
}

test("Buildchain self-dogfood composes the complete protected v3 campaign", () => {
  const report = runReleaseTrainSelfDogfoodCampaign(fixture());
  assert.equal(report.status, "passed");
  assert.equal(report.train.candidateSha, SHA("2"));
  assert.equal(report.train.observedDevSha, SHA("6"));
  assert.equal(report.repair.successorGeneration, 2);
  assert.equal(report.repair.patchRoot, ROOT("5"));
  assert.equal(report.queue.duplicateAction, "duplicate-noop");
  assert.match(
    report.negativeCases.unrelatedPriorityError,
    /source identity mismatch/u,
  );
  assert.deepEqual(
    Object.values(report.assertions),
    Object.values(report.assertions).map(() => true),
  );
  assert.deepEqual(validateReleaseTrainSelfDogfoodCampaign(report), report);
});

test("campaign replay is deterministic across restart", () => {
  const input = fixture();
  const first = runReleaseTrainSelfDogfoodCampaign(input);
  const resumed = runReleaseTrainSelfDogfoodCampaign(input);
  assert.equal(resumed.campaignRoot, first.campaignRoot);
  assert.deepEqual(resumed, first);
});

test("campaign rejects mock-only evidence without moving dev", () => {
  assert.throws(
    () =>
      runReleaseTrainSelfDogfoodCampaign(fixture({ observedDevSha: SHA("1") })),
    /requires dev to advance/u,
  );
});

test("campaign rejects a review or merge tree detached from the exact head", () => {
  const input = fixture();
  assert.throws(
    () =>
      runReleaseTrainSelfDogfoodCampaign({
        ...input,
        delivery: { ...input.delivery, reviewHeadSha: SHA("a") },
      }),
    /review does not bind/u,
  );
  assert.throws(
    () =>
      runReleaseTrainSelfDogfoodCampaign({
        ...input,
        delivery: { ...input.delivery, mergeTreeSha: SHA("a") },
      }),
    /merge tree does not equal/u,
  );
});

test("campaign report rejects rooted content drift", () => {
  const report = runReleaseTrainSelfDogfoodCampaign(fixture());
  assert.throws(
    () =>
      validateReleaseTrainSelfDogfoodCampaign({
        ...report,
        status: "planned",
      }),
    /content drift/u,
  );
});
