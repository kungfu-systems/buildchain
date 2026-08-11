import assert from "node:assert/strict";
import test from "node:test";

import {
  closeDevDeliveryWarrant,
  createDevDeliveryQueue,
  createReleaseBlockerPriorityClaim,
  rankDevDeliveryCandidates,
  selectDevDeliveryWarrant,
  submitDevDeliveryCandidate,
} from "../packages/core/dev-delivery-warrant.js";
import {
  createReleaseBlockerRepair,
  createReleaseTrain,
  settleReleaseBlockerDevLanding,
  transitionReleaseTrain,
} from "../packages/core/release-train.js";

const ROOTS = Object.fromEntries(
  [
    "assignment",
    "initiative",
    "source",
    "patch",
    "proof",
    "plan",
    "closure",
    "dependency",
    "toolchain",
    "shard",
    "context",
    "evidence",
  ].map((name, index) => [
    name,
    `sha256:${(index + 1).toString(16).repeat(64)}`,
  ]),
);

function settledReleaseBlockerRepair() {
  let train = createReleaseTrain({
    repository: "kungfu-systems/buildchain",
    sourceBranch: "dev/v4/v4.0",
    targetBranch: "alpha/v4/v4.0",
    originDevSha: "1".repeat(40),
    candidateSha: "2".repeat(40),
    candidateTreeSha: "3".repeat(40),
    alphaBaseSha: "4".repeat(40),
    buildchainRuntimeSha: "5".repeat(40),
    generation: 1,
    authorityRoots: [ROOTS.assignment, ROOTS.initiative].sort(),
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  train = transitionReleaseTrain(train, {
    to: "repair-required",
    expectedStateRoot: train.state.stateRoot,
    event: "release-blocker-confirmed",
    reason: "the active frozen candidate requires a repair",
    authorityRoots: [ROOTS.evidence],
    recordedAt: "2026-08-10T00:01:00.000Z",
  });
  const conflicted = createReleaseBlockerRepair(train, {
    expectedStateRoot: train.state.stateRoot,
    blockerRoot: ROOTS.context,
    patchRoot: ROOTS.patch,
    cutCandidateSha: "6".repeat(40),
    cutCandidateTreeSha: "7".repeat(40),
    cutPatchRoot: ROOTS.patch,
    cutLandingEvidenceRoot: ROOTS.proof,
    devLandingStatus: "conflict",
    devBaseSha: "8".repeat(40),
    devLandingSha: "",
    devPatchRoot: ROOTS.patch,
    devLandingEvidenceRoot: ROOTS.plan,
    authorityRoots: [ROOTS.closure, ROOTS.dependency].sort(),
    createdAt: "2026-08-10T00:02:00.000Z",
  });
  return settleReleaseBlockerDevLanding(conflicted, {
    expectedRepairRoot: conflicted.repairRoot,
    devBaseSha: "8".repeat(40),
    devLandingSha: "9".repeat(40),
    patchRoot: ROOTS.patch,
    devLandingEvidenceRoot: ROOTS.toolchain,
  });
}

function releaseBlockerPriorityClaim(repair = settledReleaseBlockerRepair()) {
  return createReleaseBlockerPriorityClaim(repair, {
    assignmentRoot: ROOTS.assignment,
    initiativeRoot: ROOTS.initiative,
    issuedAt: "2026-08-10T00:03:00.000Z",
  });
}

function queue() {
  return createDevDeliveryQueue({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v4/v4.0",
    policy: { agingSeconds: 300, leaseSeconds: 600 },
    now: "2026-08-10T00:00:00Z",
  });
}

function candidate(number, overrides = {}) {
  return {
    pullRequestNumber: number,
    sourceHead: ((number % 9) + 1).toString(16).repeat(40),
    assignmentRoot: ROOTS.assignment,
    initiativeRoot: ROOTS.initiative,
    sourceIdentityRoot: ROOTS.source,
    sourcePatchRoot: ROOTS.patch,
    sourceProofRoot: ROOTS.proof,
    planRoot: ROOTS.plan,
    closureRoot: ROOTS.closure,
    dependencyRoot: ROOTS.dependency,
    toolchainRoot: ROOTS.toolchain,
    deliveryClass: "native-proof-required",
    priority: "ordinary",
    ...overrides,
  };
}

test("eligible release blockers outrank ordinary work without outranking emergency work", () => {
  const claim = releaseBlockerPriorityClaim();
  let state = submitDevDeliveryCandidate(queue(), candidate(170), {
    now: "2026-08-10T00:00:00Z",
  }).queue;
  state = submitDevDeliveryCandidate(
    state,
    candidate(171, {
      sourceHead: claim.sourceHead,
      sourcePatchRoot: claim.sourcePatchRoot,
      releaseBlockerPriority: claim,
    }),
    { now: "2026-08-10T00:04:00Z" },
  ).queue;
  state = submitDevDeliveryCandidate(
    state,
    candidate(179, { priority: "emergency" }),
    { now: "2026-08-10T00:04:00Z" },
  ).queue;

  const ranked = rankDevDeliveryCandidates(state, {
    now: "2026-08-10T00:04:01Z",
  });
  assert.deepEqual(
    ranked.map(
      ({ candidate: rankedCandidate }) => rankedCandidate.pullRequestNumber,
    ),
    [179, 171, 170],
  );
  const emergency = selectDevDeliveryWarrant(state, {
    now: "2026-08-10T00:04:02Z",
  });
  state = closeDevDeliveryWarrant(emergency.queue, emergency.warrant, {
    now: "2026-08-10T00:04:03Z",
    outcome: "merged",
    evidenceRoot: ROOTS.evidence,
  }).queue;
  const selected = selectDevDeliveryWarrant(state, {
    now: "2026-08-10T00:04:04Z",
  });
  assert.equal(selected.warrant.pullRequestNumber, 171);
  assert.equal(selected.receipt.reason, "release-blocker-bounded-priority");
});

test("release-blocker priority never preempts an active Warrant", () => {
  const ordinary = submitDevDeliveryCandidate(queue(), candidate(172), {
    now: "2026-08-10T00:00:00Z",
  });
  const active = selectDevDeliveryWarrant(ordinary.queue, {
    now: "2026-08-10T00:00:01Z",
  });
  const claim = releaseBlockerPriorityClaim();
  const queued = submitDevDeliveryCandidate(
    active.queue,
    candidate(173, {
      sourceHead: claim.sourceHead,
      sourcePatchRoot: claim.sourcePatchRoot,
      releaseBlockerPriority: claim,
    }),
    { now: "2026-08-10T00:04:00Z" },
  );
  const retained = selectDevDeliveryWarrant(queued.queue, {
    now: "2026-08-10T00:04:01Z",
  });
  assert.equal(retained.receipt.reason, "non-preemptive-active-warrant");
  assert.equal(retained.warrant.pullRequestNumber, 172);
});

test("unsettled, tampered, or unrelated work cannot claim blocker priority", () => {
  const settled = settledReleaseBlockerRepair();
  const claim = releaseBlockerPriorityClaim(settled);
  assert.throws(
    () =>
      submitDevDeliveryCandidate(
        queue(),
        candidate(174, {
          sourceHead: "a".repeat(40),
          releaseBlockerPriority: claim,
        }),
        { now: "2026-08-10T00:04:00Z" },
      ),
    /source identity mismatch/u,
  );
  assert.throws(
    () =>
      submitDevDeliveryCandidate(
        queue(),
        candidate(174, {
          sourceHead: claim.sourceHead,
          releaseBlockerPriority: { ...claim, claimRoot: ROOTS.shard },
        }),
        { now: "2026-08-10T00:04:00Z" },
      ),
    /claimRoot drift/u,
  );

  const conflicted = createReleaseBlockerRepair(settled.priorTrain, {
    expectedStateRoot: settled.priorTrain.state.stateRoot,
    blockerRoot: settled.blockerRoot,
    patchRoot: settled.patchRoot,
    cutCandidateSha: settled.cutLanding.landedSha,
    cutCandidateTreeSha: settled.successorTrain.releaseCut.candidateTreeSha,
    cutPatchRoot: settled.cutLanding.patchRoot,
    cutLandingEvidenceRoot: settled.cutLanding.evidenceRoot,
    devLandingStatus: "conflict",
    devBaseSha: settled.devLanding.baseSha,
    devLandingSha: "",
    devPatchRoot: settled.patchRoot,
    devLandingEvidenceRoot: ROOTS.plan,
    authorityRoots: settled.authorityRoots,
    createdAt: settled.createdAt,
  });
  assert.throws(
    () => releaseBlockerPriorityClaim(conflicted),
    /exact settled dev landing/u,
  );
});
