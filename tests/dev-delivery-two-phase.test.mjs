import assert from "node:assert/strict";
import test from "node:test";

import {
  createDevDeliveryQueue,
  createNativeProofReuseDecision,
  createNativeQualificationProof,
  devDeliveryContentRoot,
  heartbeatDevDeliveryWarrant,
  qualifyDevDeliveryWarrant,
  recoverExpiredDevDeliveryWarrant,
  selectDevDeliveryWarrant,
  submitDevDeliveryCandidate,
  verifyNativeProofReuseDecision,
  verifyNativeQualificationProof,
} from "../packages/core/dev-delivery-warrant.js";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;
const SOURCE_HEAD = "a".repeat(40);
const QUALIFIED_BASE = "b".repeat(40);

function candidate(number = 401, overrides = {}) {
  return {
    pullRequestNumber: number,
    sourceHead: SOURCE_HEAD,
    assignmentRoot: ROOT("1"),
    initiativeRoot: ROOT("2"),
    sourceIdentityRoot: ROOT("3"),
    sourcePatchRoot: ROOT("4"),
    sourceProofRoot: ROOT("5"),
    planRoot: ROOT("6"),
    closureRoot: ROOT("7"),
    dependencyRoot: ROOT("8"),
    toolchainRoot: ROOT("9"),
    environmentRoot: ROOT("a"),
    deliveryClass: "native-proof-required",
    priority: "ordinary",
    ...overrides,
  };
}

function selectedQueue(overrides = {}) {
  const initial = createDevDeliveryQueue({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v3/v3.0",
    policy: { leaseSeconds: 120 },
    now: "2026-08-11T00:00:00Z",
  });
  const submitted = submitDevDeliveryCandidate(
    initial,
    candidate(401, overrides),
    { now: "2026-08-11T00:00:01Z" },
  );
  return selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-11T00:00:02Z",
    leaseSeconds: 120,
  });
}

function nativeProof(overrides = {}) {
  return createNativeQualificationProof({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v3/v3.0",
    sourceIdentityRoot: ROOT("3"),
    sourcePatchRoot: ROOT("4"),
    planRoot: ROOT("6"),
    closureRoot: ROOT("7"),
    dependencyRoot: ROOT("8"),
    toolchainRoot: ROOT("9"),
    environmentRoot: ROOT("a"),
    qualifiedBase: QUALIFIED_BASE,
    affectedPaths: ["packages/native", "pnpm-lock.yaml"],
    shardEvidenceRoots: [ROOT("c"), ROOT("d")],
    qualifiedAt: "2026-08-11T00:00:30Z",
    ...overrides,
  });
}

function current(overrides = {}) {
  return {
    sourceIdentityRoot: ROOT("3"),
    sourcePatchRoot: ROOT("4"),
    planRoot: ROOT("6"),
    closureRoot: ROOT("7"),
    dependencyRoot: ROOT("8"),
    toolchainRoot: ROOT("9"),
    environmentRoot: ROOT("a"),
    currentBase: QUALIFIED_BASE,
    graphKnown: true,
    attributionComplete: true,
    changedPaths: [],
    renames: [],
    ...overrides,
  };
}

test("selection issues a provisional Warrant before expensive native work", () => {
  const selected = selectedQueue();
  assert.equal(selected.warrant.phase, "provisional");
  assert.equal(selected.queue.candidates[0].status, "selected");
  assert.match(selected.warrant.fencingToken, /^sha256:[0-9a-f]{64}$/u);
  assert.match(selected.warrant.nextAction, /native proof/u);
});

test("native success atomically qualifies the same fencing generation", () => {
  const selected = selectedQueue();
  const proof = nativeProof();
  const reuse = createNativeProofReuseDecision({ proof, current: current() });
  const qualified = qualifyDevDeliveryWarrant(
    selected.queue,
    selected.warrant,
    {
      nativeProof: proof,
      reuseDecision: reuse,
      current: current(),
      now: "2026-08-11T00:00:31Z",
    },
  );

  assert.equal(qualified.warrant.phase, "qualified");
  assert.equal(qualified.warrant.fencingToken, selected.warrant.fencingToken);
  assert.equal(qualified.warrant.generation, selected.warrant.generation);
  assert.equal(qualified.warrant.nativeProofRoot, proof.proofRoot);
  assert.equal(qualified.warrant.nativeProofReuseRoot, reuse.decisionRoot);
  assert.equal(qualified.queue.candidates[0].status, "qualified");
  assert.equal(qualified.receipt.action, "qualified-warrant");
});

test("base-only drift reuses native proof when affected closure is disjoint", () => {
  const proof = nativeProof();
  const reuseCurrent = current({
    currentBase: "c".repeat(40),
    changedPaths: ["docs/release-governance.md", "packages/web/index.js"],
  });
  const decision = createNativeProofReuseDecision({
    proof,
    current: reuseCurrent,
  });
  assert.equal(decision.reusable, true);
  assert.equal(decision.action, "reuse-native-proof");
  assert.equal(
    decision.reason,
    "semantic-source-stable-and-base-delta-disjoint",
  );
  assert.deepEqual(decision.overlappingPaths, []);
  assert.equal(
    verifyNativeProofReuseDecision(decision, {
      proof,
      current: reuseCurrent,
    }).ok,
    true,
  );
});

test("overlap, unknown attribution, semantic change, and toolchain change fail closed", () => {
  const proof = nativeProof();
  const cases = [
    [
      current({
        currentBase: "c".repeat(40),
        changedPaths: ["packages/native/runtime.cc"],
      }),
      "rerun-affected-native-shards",
      "base-delta-overlaps-affected-closure",
    ],
    [
      current({
        currentBase: "c".repeat(40),
        graphKnown: false,
      }),
      "rerun-full-native-qualification",
      "base-delta-attribution-unknown",
    ],
    [
      current({ sourcePatchRoot: ROOT("e") }),
      "rerun-full-native-qualification",
      "sourcePatchRoot-changed-or-unknown",
    ],
    [
      current({ toolchainRoot: ROOT("e") }),
      "rerun-full-native-qualification",
      "toolchainRoot-changed-or-unknown",
    ],
    [
      current({ environmentRoot: ROOT("e") }),
      "rerun-full-native-qualification",
      "environmentRoot-changed-or-unknown",
    ],
    [
      current({
        currentBase: "c".repeat(40),
        attributionComplete: false,
      }),
      "rerun-full-native-qualification",
      "base-delta-attribution-unknown",
    ],
  ];
  for (const [value, action, reason] of cases) {
    const decision = createNativeProofReuseDecision({ proof, current: value });
    assert.equal(decision.reusable, false);
    assert.equal(decision.action, action);
    assert.equal(decision.reason, reason);
  }
});

test("rename and generated-surface overlap are attributed on both sides", () => {
  const proof = nativeProof({
    affectedPaths: ["packages/native", "dist/native"],
  });
  const renamed = createNativeProofReuseDecision({
    proof,
    current: current({
      currentBase: "c".repeat(40),
      changedPaths: ["docs/native.md"],
      renames: [{ from: "packages/native/README.md", to: "docs/native.md" }],
    }),
  });
  assert.equal(renamed.reusable, false);
  assert.equal(renamed.reason, "base-delta-overlaps-affected-closure");
  assert.deepEqual(renamed.overlappingPaths, ["packages/native/README.md"]);

  const generated = createNativeProofReuseDecision({
    proof,
    current: current({
      currentBase: "c".repeat(40),
      changedPaths: ["dist/native/index.js"],
    }),
  });
  assert.equal(generated.reusable, false);
  assert.equal(generated.action, "rerun-affected-native-shards");
});

test("reuse decision and base-delta lineage root are deterministic", () => {
  const proof = nativeProof();
  const input = current({
    currentBase: "c".repeat(40),
    changedPaths: ["docs/b.md", "docs/a.md", "docs/a.md"],
  });
  const first = createNativeProofReuseDecision({ proof, current: input });
  const second = createNativeProofReuseDecision({ proof, current: input });
  assert.deepEqual(first, second);
  assert.match(first.baseDeltaRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(first.decisionRoot, second.decisionRoot);
});

test("qualification rejects overlapping base changes and semantic proof drift", () => {
  const selected = selectedQueue();
  const proof = nativeProof();
  const overlapCurrent = current({
    currentBase: "c".repeat(40),
    changedPaths: ["packages/native/runtime.cc"],
  });
  const overlap = createNativeProofReuseDecision({
    proof,
    current: overlapCurrent,
  });
  assert.throws(
    () =>
      qualifyDevDeliveryWarrant(selected.queue, selected.warrant, {
        nativeProof: proof,
        reuseDecision: overlap,
        current: overlapCurrent,
        now: "2026-08-11T00:00:31Z",
      }),
    /native proof is not reusable/u,
  );

  const drifted = nativeProof({ sourcePatchRoot: ROOT("e") });
  const driftDecision = createNativeProofReuseDecision({
    proof: drifted,
    current: current({ sourcePatchRoot: ROOT("e") }),
  });
  assert.throws(
    () =>
      qualifyDevDeliveryWarrant(selected.queue, selected.warrant, {
        nativeProof: drifted,
        reuseDecision: driftDecision,
        current: current(),
        now: "2026-08-11T00:00:31Z",
      }),
    /native proof rejected: sourcePatchRoot-mismatch/u,
  );
});

test("provisional heartbeat preserves order and expiry recovery fences stale workers", () => {
  const selected = selectedQueue();
  const heartbeat = heartbeatDevDeliveryWarrant(
    selected.queue,
    selected.warrant,
    {
      now: "2026-08-11T00:01:00Z",
      leaseSeconds: 120,
    },
  );
  assert.equal(heartbeat.queue.activeWarrant.phase, "provisional");
  assert.equal(heartbeat.queue.candidates[0].status, "proving");

  const recovered = recoverExpiredDevDeliveryWarrant(heartbeat.queue, {
    now: "2026-08-11T00:04:00Z",
  });
  const reselection = selectDevDeliveryWarrant(recovered.queue, {
    now: "2026-08-11T00:04:01Z",
  });
  assert.equal(reselection.warrant.phase, "provisional");
  assert.notEqual(
    reselection.warrant.fencingToken,
    selected.warrant.fencingToken,
  );
  assert.throws(
    () =>
      heartbeatDevDeliveryWarrant(reselection.queue, selected.warrant, {
        now: "2026-08-11T00:04:02Z",
      }),
    /stale fencing token/u,
  );
});

test("native proof timestamp is observational while semantic evidence is rooted", () => {
  const first = nativeProof();
  const second = nativeProof({ qualifiedAt: "2026-08-11T00:00:45Z" });
  assert.equal(first.proofRoot, second.proofRoot);
  assert.notEqual(first.observationRoot, second.observationRoot);
  assert.equal(verifyNativeQualificationProof(first).ok, true);
  assert.equal(verifyNativeQualificationProof(second).ok, true);
});

test("legacy v1 native proof remains verifiable but cannot gain v2 reuse", () => {
  const proof = nativeProof();
  proof.schema = "kungfu.buildchain.native-qualification-proof/v1";
  delete proof.environmentRoot;
  const identity = structuredClone(proof);
  delete identity.proofRoot;
  delete identity.qualifiedAt;
  delete identity.observationRoot;
  proof.proofRoot = devDeliveryContentRoot(identity);
  assert.equal(verifyNativeQualificationProof(proof).ok, true);
  const decision = createNativeProofReuseDecision({ proof, current: current() });
  assert.equal(decision.reusable, false);
  assert.equal(decision.reason, "environmentRoot-changed-or-unknown");
});
