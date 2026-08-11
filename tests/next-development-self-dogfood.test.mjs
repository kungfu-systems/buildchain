import assert from "node:assert/strict";
import test from "node:test";

import {
  createHostedSelfDogfoodEvidence,
  createSelfDogfoodCheckpoint,
  resumeSelfDogfoodCheckpoint,
  validateHostedSelfDogfoodEvidence,
  validateSelfDogfoodCheckpoint,
  validateSelfDogfoodEvidence,
} from "../scripts/next-development-self-dogfood.mjs";
import { nextDevelopmentRoot } from "../packages/core/next-development-transition.js";

const REPOSITORY = "kungfu-systems/buildchain";
const RUNTIME_SHA = "a".repeat(40);
const STABLE_SHA = "b".repeat(40);
const CONTRACT_ROOT = nextDevelopmentRoot({ contract: "v3-alpha" });

async function checkpoint() {
  return createSelfDogfoodCheckpoint({
    repository: REPOSITORY,
    runtimeRef: "v3-alpha",
    runtimeSha: RUNTIME_SHA,
    contractRoot: CONTRACT_ROOT,
    runnerId: "run-41:fault-runner",
  });
}

function observation(overrides = {}) {
  return {
    repository: REPOSITORY,
    callerSha: "c".repeat(40),
    checkedAt: "2026-08-11T03:00:00.000Z",
    observed: {
      alpha: {
        ref: "v3-alpha",
        sha: RUNTIME_SHA,
        class: "alpha",
        expectedSha: RUNTIME_SHA,
      },
      stable: {
        ref: "v3",
        sha: STABLE_SHA,
        class: "stable",
        expectedSha: STABLE_SHA,
      },
    },
    protectedDevReadback: {
      repository: REPOSITORY,
      branch: "dev/v3/v3.0",
      commitSha: "d".repeat(40),
      treeSha: "e".repeat(40),
      versionRoots: [
        { path: ".buildchain/release-impact.json", gitBlobSha: "1".repeat(40) },
        { path: "dist/site/buildchain-contract.json", gitBlobSha: "2".repeat(40) },
        { path: "package.json", gitBlobSha: "3".repeat(40) },
      ],
    },
    ...overrides,
  };
}

test("checkpoint uses the public owner/repo route and real adapter before a transient durable-state failure", async () => {
  const result = await checkpoint();
  assert.equal(
    result.route.publicWorkflow,
    "kungfu-systems/buildchain/.github/workflows/build.yml@v3-alpha",
  );
  assert.equal(result.route.runtimeSha, RUNTIME_SHA);
  assert.equal(result.semver.controller.transition.state.status, "planned");
  assert.equal(result.semver.controller.activeAttempt, null);
  assert.equal(result.semver.durableStateFailures, 1);
  assert.equal(result.semver.materializations, 1);
  assert.equal(
    result.semver.adapterOperations[0].adapterContract,
    "kungfu-buildchain-next-development-transition/v1",
  );
  assert.match(result.semver.adapterOperations[0].operationRoot, /^sha256:/u);
  assert.deepEqual(validateSelfDogfoodCheckpoint(result), result);
});

test("public route validation rejects a fork-local or shorthand workflow coordinate", async () => {
  await assert.rejects(
    createSelfDogfoodCheckpoint({
      repository: "example/buildchain",
      runtimeRef: "v3-alpha",
      runtimeSha: RUNTIME_SHA,
      contractRoot: CONTRACT_ROOT,
      runnerId: "fault",
    }),
    /public kungfu-systems\/buildchain/u,
  );
});

test("anchored/manual remains durably waiting before reviewed input exists", async () => {
  const result = await checkpoint();
  assert.equal(result.anchored.materializations, 0);
  assert.equal(
    result.anchored.controller.transition.state.status,
    "waiting-anchor",
  );
  assert.equal(result.anchored.controller.transition.target.version, null);
});

test("fresh runner reuses durable adapter output, handles moved Dev and waits for protected PR", async () => {
  const initial = await checkpoint();
  const evidence = await resumeSelfDogfoodCheckpoint(initial, {
    runnerId: "run-41:fresh-resume-runner",
  });

  assert.equal(evidence.status, "passed");
  assert.equal(evidence.recovery.freshRunner, true);
  assert.equal(evidence.recovery.transientDurableStateFailures, 1);
  assert.equal(evidence.recovery.recoveredAdapterOperations, 1);
  assert.equal(evidence.recovery.alphaCandidateRebuilds, 0);
  assert.equal(evidence.recovery.devMaterializationsBefore, 1);
  assert.equal(evidence.recovery.devMaterializationsAfter, 2);
  assert.equal(evidence.recovery.protectedDevMovement.supersededAttempts, 1);
  assert.notEqual(
    evidence.recovery.protectedDevMovement.initialSha,
    evidence.recovery.protectedDevMovement.movedSha,
  );
  assert.deepEqual(evidence.recovery.protectedPrDelay, {
    status: "pr-pending",
    delayedStatus: "pr-pending",
    unchangedControllerRoot: true,
  });
  assert.equal(evidence.models.semverAuto.status, "verified");
  assert.equal(evidence.models.semverAuto.targetVersion, "3.0.9-alpha.2");
  assert.equal(evidence.models.anchoredManual.waitingStatus, "waiting-anchor");
  assert.equal(evidence.models.anchoredManual.status, "verified");
  assert.equal(evidence.models.anchoredManual.targetVersion, "22.1.0");
  assert.equal(evidence.adapter.operations.length, 3);
  assert.deepEqual(
    new Set(evidence.adapter.operations.map((entry) => entry.model)),
    new Set(["semver", "anchored"]),
  );
  assert.deepEqual(validateSelfDogfoodEvidence(evidence), evidence);
});

test("same-runner recovery and every rooted boundary fail closed", async () => {
  const initial = await checkpoint();
  await assert.rejects(
    resumeSelfDogfoodCheckpoint(initial, { runnerId: initial.faultRunnerId }),
    /fresh runner identity/u,
  );

  const evidence = await resumeSelfDogfoodCheckpoint(initial, {
    runnerId: "run-41:fresh-resume-runner",
  });
  for (const mutate of [
    (forged) => { forged.recovery.transientDurableStateFailures = 0; },
    (forged) => { forged.adapter.operations[0].materializationRoot = CONTRACT_ROOT; },
    (forged) => { forged.models.semverAuto.controller.readback.agrees = false; },
  ]) {
    const forged = structuredClone(evidence);
    mutate(forged);
    assert.throws(() => validateSelfDogfoodEvidence(forged));
  }
});

test("hosted evidence roots the exact protected Dev readback and floating refs", async () => {
  const proof = await resumeSelfDogfoodCheckpoint(await checkpoint(), {
    runnerId: "run-41:fresh-resume-runner",
  });
  const evidence = createHostedSelfDogfoodEvidence({
    nextDevelopment: proof,
    observation: observation(),
  });
  assert.equal(evidence.status, "passed");
  assert.match(evidence.hostedProtectedDevReadback.evidenceRoot, /^sha256:/u);
  assert.match(evidence.evidenceRoot, /^sha256:/u);
  assert.deepEqual(validateHostedSelfDogfoodEvidence(evidence), evidence);

  const drifted = structuredClone(evidence);
  drifted.hostedProtectedDevReadback.versionRoots[0].gitBlobSha = "4".repeat(40);
  assert.throws(
    () => validateHostedSelfDogfoodEvidence(drifted),
    /evidence root drifted/u,
  );
});

test("hosted route mismatch remains rooted failed evidence and is rejected", async () => {
  const proof = await resumeSelfDogfoodCheckpoint(await checkpoint(), {
    runnerId: "run-41:fresh-resume-runner",
  });
  const mismatched = observation();
  mismatched.observed.alpha.expectedSha = "f".repeat(40);
  const evidence = createHostedSelfDogfoodEvidence({
    nextDevelopment: proof,
    observation: mismatched,
  });
  assert.equal(evidence.status, "failed");
  assert.match(evidence.evidenceRoot, /^sha256:/u);
  assert.throws(
    () => validateHostedSelfDogfoodEvidence(evidence),
    /not a passing exact readback/u,
  );
});

test("floating v3 production coordinate is mandatory", async () => {
  const evidence = await resumeSelfDogfoodCheckpoint(await checkpoint(), {
    runnerId: "run-41:fresh-resume-runner",
  });
  const pinned = structuredClone(evidence);
  pinned.adoption.coordinate =
    "kungfu-systems/buildchain/.github/workflows/build.yml@" + RUNTIME_SHA;
  pinned.evidenceRoot = nextDevelopmentRoot(
    Object.fromEntries(
      Object.entries(pinned).filter(([key]) => key !== "evidenceRoot"),
    ),
  );
  assert.throws(
    () => validateSelfDogfoodEvidence(pinned),
    /floating v3 coordinate/u,
  );
});
