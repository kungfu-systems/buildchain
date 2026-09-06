import assert from "node:assert/strict";
import test from "node:test";
import {
  createV4UniversalSelfDogfoodRequest,
  verifyV4UniversalSelfDogfoodPair,
} from "../scripts/v4-universal-workflow-self-dogfood.mjs";

const sha = (value) => value.repeat(40);
const root = (value) => `sha256:${value.repeat(64)}`;
const policy = {
  schema: "kungfu-buildchain-v4-universal-workflow-admission-policy/v1",
  sourceRepository: "kungfu-systems/buildchain",
  consumerAdmission: "verified-caller",
  allowedCapabilities: [
    "bootstrap-conformance",
    "release-candidate-promote",
    "release-invocation",
  ],
  permissionCeiling: { contents: "write" },
  contractRoots: [root("a")],
  targetRef: "dev/v4/v4.0",
  allowedReviewers: ["kungfu-origin"],
  minimumApprovals: 1,
  requiredChecks: ["check"],
  validFrom: "2026-08-30T00:00:00.000Z",
  expiresAt: "2026-09-07T00:00:00.000Z",
};

test("Train-first requests exercise conformance plus alpha and stable routes", () => {
  for (const channel of ["conformance", "alpha", "stable"]) {
    const request = createV4UniversalSelfDogfoodRequest({
      candidateSha: sha("1"),
      consumerSha: sha("2"),
      pullRequest: 3320,
      channel,
      policy,
    });
    assert.equal(request.mode, "train");
    assert.equal(request.candidate.expectedSha, sha("1"));
    assert.equal(request.consumer.sourceSha, sha("2"));
    assert.equal(
      request.capability.id,
      channel === "conformance"
        ? "bootstrap-conformance"
        : "release-candidate-promote",
    );
    if (channel !== "conformance")
      assert.equal(request.payload.inputs["dry-run"], true);
  }
});

test("primary and recovery results must be byte-equivalent candidate execution", () => {
  const result = {
    schema: "kungfu-buildchain-v4-universal-workflow-result/v1",
    status: "succeeded",
    requestRoot: root("1"),
    runtime: { repository: "kungfu-systems/buildchain", sha: sha("1") },
    capabilityRoot: root("2"),
    enginePath: "scripts/v4-universal-workflow-engine.mjs",
    output: {
      dryRun: true,
      route: { decision: "Fresh", channel: "alpha" },
    },
    resultRoot: root("3"),
  };
  const pair = verifyV4UniversalSelfDogfoodPair({
    primary: result,
    recovery: structuredClone(result),
    expectedSha: sha("1"),
    channel: "alpha",
  });
  assert.equal(pair.equivalent, true);
  assert.match(pair.pairRoot, /^sha256:[0-9a-f]{64}$/u);
  const drifted = structuredClone(result);
  drifted.resultRoot = root("4");
  assert.throws(() =>
    verifyV4UniversalSelfDogfoodPair({
      primary: result,
      recovery: drifted,
      expectedSha: sha("1"),
      channel: "alpha",
    }),
  );
});
