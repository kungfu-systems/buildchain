import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  LEGACY_DEV_ALPHA_CANDIDATE_STATE_SCHEMA,
  RELEASE_CUT_CONTRACT,
  RELEASE_TRAIN_CONTRACT,
  RELEASE_TRAIN_STATES,
  RELEASE_TRAIN_SUPERSESSION_CAUSES,
  createReleaseCut,
  createReleaseTrain,
  observeReleaseTrain,
  readReleaseTrain,
  transitionReleaseTrain,
  validateReleaseCut,
  validateReleaseTrain,
} from "../packages/core/release-train.js";

const SHA = {
  origin: "1".repeat(40),
  candidate: "2".repeat(40),
  tree: "3".repeat(40),
  alpha: "4".repeat(40),
  runtime: "5".repeat(40),
  laterDev: "6".repeat(40),
  replacement: "7".repeat(40),
  replacementTree: "8".repeat(40),
};
const ROOT = (digit) => `sha256:${digit.repeat(64)}`;

function cutInput(overrides = {}) {
  return {
    repository: "kungfu-systems/buildchain",
    sourceBranch: "dev/v3/v3.0",
    targetBranch: "alpha/v3/v3.0",
    originDevSha: SHA.origin,
    candidateSha: SHA.candidate,
    candidateTreeSha: SHA.tree,
    alphaBaseSha: SHA.alpha,
    buildchainRuntimeSha: SHA.runtime,
    generation: 1,
    authorityRoots: [ROOT("a"), ROOT("b")],
    createdAt: "2026-08-10T12:00:00.000Z",
    ...overrides,
  };
}

function transitionInput(train, overrides = {}) {
  return {
    to: "building",
    event: "candidate-build-started",
    reason: "the frozen candidate entered the build matrix",
    expectedStateRoot: train.state.stateRoot,
    authorityRoots: [ROOT("c")],
    recordedAt: "2026-08-10T12:01:00.000Z",
    ...overrides,
  };
}

test("a Release Cut freezes every candidate identity and authority coordinate", () => {
  const first = createReleaseCut(cutInput());
  const replay = createReleaseCut(cutInput());
  assert.deepEqual(replay, first);
  assert.equal(first.contract, RELEASE_CUT_CONTRACT);
  assert.equal(first.originDevSha, SHA.origin);
  assert.equal(first.candidateSha, SHA.candidate);
  assert.equal(first.candidateTreeSha, SHA.tree);
  assert.equal(first.alphaBaseSha, SHA.alpha);
  assert.equal(first.buildchainRuntimeSha, SHA.runtime);
  assert.equal(first.generation, 1);
  assert.match(first.cutRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(validateReleaseCut(first), first);
  assert.throws(
    () => validateReleaseCut({ ...first, candidateSha: SHA.laterDev }),
    /Release Cut root/u,
  );
  assert.throws(
    () =>
      createReleaseCut(cutInput({ authorityRoots: [ROOT("b"), ROOT("a")] })),
    /sorted and duplicate-free/u,
  );
});

test("newer dev observations cannot mutate the frozen candidate or generation", () => {
  const train = createReleaseTrain(cutInput());
  const observed = observeReleaseTrain(train, {
    observedDevSha: SHA.laterDev,
    observedAt: "2026-08-10T12:02:00.000Z",
  });
  assert.equal(observed.contract, RELEASE_TRAIN_CONTRACT);
  assert.equal(observed.releaseCut.originDevSha, SHA.origin);
  assert.equal(observed.releaseCut.candidateSha, SHA.candidate);
  assert.equal(observed.releaseCut.generation, 1);
  assert.equal(observed.trainRoot, train.trainRoot);
  assert.equal(observed.state.stateRoot, train.state.stateRoot);
  assert.equal(observed.observations.length, 1);
  assert.deepEqual(
    observeReleaseTrain(observed, observed.observations[0]),
    observed,
  );
});

test("state transitions are rooted, compare-and-swap guarded and idempotent", () => {
  const initial = createReleaseTrain(cutInput());
  const command = transitionInput(initial);
  const building = transitionReleaseTrain(initial, command);
  assert.equal(building.state.status, "building");
  assert.equal(building.state.priorStateRoot, initial.state.stateRoot);
  assert.match(building.transitions[0].requestRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(
    building.transitions[0].transitionRoot,
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.deepEqual(transitionReleaseTrain(building, command), building);
  assert.deepEqual(validateReleaseTrain(building), building);
  assert.throws(
    () =>
      transitionReleaseTrain(building, {
        ...transitionInput(building, {
          to: "publishable",
          event: "candidate-qualified",
          reason: "all candidate checks passed",
        }),
        expectedStateRoot: initial.state.stateRoot,
      }),
    /compare-and-swap failed/u,
  );
  assert.throws(
    () =>
      transitionReleaseTrain(initial, {
        ...command,
        to: "terminal",
      }),
    /invalid Release Train transition/u,
  );
});

test("the state machine exposes every declared lifecycle state", () => {
  assert.deepEqual(RELEASE_TRAIN_STATES, [
    "preparing",
    "building",
    "repair-required",
    "publication-blocked",
    "publishable",
    "superseded",
    "terminal",
  ]);
  let train = createReleaseTrain(cutInput());
  train = transitionReleaseTrain(train, transitionInput(train));
  train = transitionReleaseTrain(
    train,
    transitionInput(train, {
      to: "publication-blocked",
      event: "publication-authority-missing",
      reason: "publication authority is not yet complete",
      recordedAt: "2026-08-10T12:02:00.000Z",
    }),
  );
  train = transitionReleaseTrain(
    train,
    transitionInput(train, {
      to: "repair-required",
      event: "repair-requested",
      reason: "the authority failure requires rooted repair",
      recordedAt: "2026-08-10T12:03:00.000Z",
    }),
  );
  train = transitionReleaseTrain(
    train,
    transitionInput(train, {
      to: "building",
      event: "repair-landed",
      reason: "the same frozen candidate resumed after repair",
      recordedAt: "2026-08-10T12:04:00.000Z",
    }),
  );
  train = transitionReleaseTrain(
    train,
    transitionInput(train, {
      to: "publishable",
      event: "candidate-qualified",
      reason: "the frozen candidate is publishable",
      recordedAt: "2026-08-10T12:05:00.000Z",
    }),
  );
  train = transitionReleaseTrain(
    train,
    transitionInput(train, {
      to: "terminal",
      event: "release-published",
      reason: "provider readback confirms the terminal release",
      recordedAt: "2026-08-10T12:06:00.000Z",
    }),
  );
  assert.equal(train.state.status, "terminal");
  assert.equal(train.transitions.length, 6);
  assert.deepEqual(validateReleaseTrain(train), train);
});

test("only enumerated causes can supersede a candidate", () => {
  assert.deepEqual(RELEASE_TRAIN_SUPERSESSION_CAUSES, [
    "incompatible-semantics",
    "alpha-base-incompatibility",
    "invalid-authority",
    "severe-security",
  ]);
  const train = createReleaseTrain(cutInput());
  const base = transitionInput(train, {
    to: "superseded",
    event: "candidate-invalidated",
    reason: "the candidate authority is invalid",
    replacementCutRoot: ROOT("d"),
    replacementCandidateSha: SHA.replacement,
  });
  assert.throws(
    () =>
      transitionReleaseTrain(train, {
        ...base,
        supersessionCause: "newer-dev-head",
      }),
    /enumerated cause/u,
  );
  const superseded = transitionReleaseTrain(train, {
    ...base,
    supersessionCause: "invalid-authority",
  });
  assert.equal(superseded.state.status, "superseded");
  assert.equal(
    superseded.transitions[0].supersessionCause,
    "invalid-authority",
  );

  assert.throws(
    () => createReleaseCut(cutInput({ generation: 2 })),
    /supersession must be an object/u,
  );
  const replacement = createReleaseCut(
    cutInput({
      candidateSha: SHA.replacement,
      candidateTreeSha: SHA.replacementTree,
      generation: 2,
      supersession: {
        cause: "invalid-authority",
        priorCutRoot: train.releaseCut.cutRoot,
      },
      createdAt: "2026-08-10T12:07:00.000Z",
    }),
  );
  assert.equal(replacement.generation, 2);
  assert.equal(replacement.supersession.priorCutRoot, train.releaseCut.cutRoot);
});

test("tampered roots and chains fail closed", () => {
  let train = createReleaseTrain(cutInput());
  train = transitionReleaseTrain(train, transitionInput(train));
  const cutDrift = structuredClone(train);
  cutDrift.releaseCut.candidateSha = SHA.laterDev;
  assert.throws(() => validateReleaseTrain(cutDrift), /Release Cut root/u);
  const stateDrift = structuredClone(train);
  stateDrift.state.status = "publishable";
  assert.throws(() => validateReleaseTrain(stateDrift), /state root/u);
  const transitionDrift = structuredClone(train);
  transitionDrift.transitions[0].reason = "rewritten after the fact";
  assert.throws(
    () => validateReleaseTrain(transitionDrift),
    /transition root/u,
  );
  const edgeDrift = structuredClone(train);
  edgeDrift.transitions[0].from = "repair-required";
  assert.throws(() => validateReleaseTrain(edgeDrift), /transition root/u);

  const observed = observeReleaseTrain(train, {
    observedDevSha: SHA.laterDev,
    observedAt: "2026-08-10T12:02:00.000Z",
  });
  const observationDrift = structuredClone(observed);
  observationDrift.observations[0].trainRoot = ROOT("f");
  assert.throws(
    () => validateReleaseTrain(observationDrift),
    /observation root/u,
  );
});

test("legacy patrol state is read-only and never manufactures Release Cut authority", () => {
  const projection = readReleaseTrain({
    schema: LEGACY_DEV_ALPHA_CANDIDATE_STATE_SCHEMA,
    generation: 4,
    stateRoot: ROOT("e"),
    activeCandidate: { sourceSha: SHA.candidate },
  });
  assert.equal(projection.authoritative, false);
  assert.equal(projection.train, null);
  assert.equal(projection.legacy.generation, 4);
  assert.equal(projection.legacy.candidateSha, SHA.candidate);
  assert.match(projection.reason, /cannot manufacture Release Cut authority/u);
  assert.equal(
    readReleaseTrain(createReleaseTrain(cutInput())).authoritative,
    true,
  );
});

test("versioned Release Cut, Release Train and transition schemas accept valid records", () => {
  const ajv = new Ajv2020({ strict: false, formats: { "date-time": true } });
  const load = (name) =>
    JSON.parse(
      fs.readFileSync(new URL(`../contracts/${name}`, import.meta.url), "utf8"),
    );
  const cutSchema = load("release-cut-v1.schema.json");
  const transitionSchema = load("release-train-transition-v1.schema.json");
  const trainSchema = load("release-train-v1.schema.json");
  ajv.addSchema(cutSchema);
  ajv.addSchema(transitionSchema);
  const validate = ajv.compile(trainSchema);
  let train = createReleaseTrain(cutInput());
  train = transitionReleaseTrain(train, transitionInput(train));
  assert.equal(validate(train), true, JSON.stringify(validate.errors));
});
