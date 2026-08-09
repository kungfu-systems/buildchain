import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { planV4PartialMutationRecovery } from "../packages/core/v4-partial-mutation-recovery-qualification.js";
import { projectV4ReleaseActivation } from "../packages/core/v4-release-activation-shadow.js";
import { planV4StageCapsuleResume } from "../packages/core/v4-stage-capsule-resume-planner.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtures = JSON.parse(
  fs.readFileSync(
    new URL(
      "../contracts/fixtures/v4-partial-mutation-recovery-v1/shared.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function clone(value) {
  return structuredClone(value);
}

function root(character) {
  return `sha256:${character.repeat(64)}`;
}

function materializeCase(entry) {
  const request = clone(fixtures.baseRequest);
  if (entry.compensableBoundaryRoots)
    request.compensableBoundaryRoots = clone(entry.compensableBoundaryRoots);
  for (const update of entry.steps) {
    const step = request.activation.steps.find(
      ({ stepId }) => stepId === update.stepId,
    );
    step.phase = update.phase;
    step.attemptCount = update.attemptCount;
    const retained = update.phase !== "planned";
    step.journalRoot = retained ? root("0") : null;
    step.journalStateRoot = retained ? root("1") : null;
  }
  return request;
}

function expectFault(request, code) {
  assert.throws(
    () => planV4PartialMutationRecovery(request),
    (error) => error.code === code,
  );
}

test("fixture scenarios produce one deterministic bounded recovery classification", () => {
  const observed = new Set();
  for (const entry of fixtures.cases) {
    const request = materializeCase(entry);
    const left = planV4PartialMutationRecovery(request);
    const right = planV4PartialMutationRecovery(clone(request));
    assert.deepEqual(right, left, entry.id);
    assert.equal(left.classification, entry.expectedClassification, entry.id);
    assert.deepEqual(
      left.nextOperations.map(({ stepId }) => stepId),
      entry.expectedNextStepIds,
      entry.id,
    );
    assert.equal(left.mode, "shadow-only");
    assert.equal(left.productionAuthority, "v3");
    assert.equal(left.zeroExternalMutations, true);
    assert.equal(left.complexity.externalMutationCount, 0);
    observed.add(left.classification);
  }
  assert.deepEqual([...observed].sort(), [
    "compensate",
    "escalate",
    "reconcile",
    "retry",
    "terminal-noop",
    "wait",
  ]);
});

test("confirmed operations are terminal noops and never replay across repeated resume", () => {
  const entry = fixtures.cases.find(
    ({ id }) => id === "partial-multi-provider",
  );
  const plan = planV4PartialMutationRecovery(materializeCase(entry));
  assert.deepEqual(plan.terminalOperationRoots, [root("b")]);
  assert.equal(
    plan.nextOperations.some(
      ({ operationRoot }) => operationRoot === root("b"),
    ),
    false,
  );
  assert.equal(
    plan.nextOperations.find(({ stepId }) => stepId === "oci-image").action,
    "compensate",
  );
  assert.equal(
    plan.nextOperations.find(({ stepId }) => stepId === "npm-package").action,
    "retry",
  );
});

test("missing, expired, and corrupt Stage Capsule evidence fails closed at the exact stage checkpoint", () => {
  for (const entry of fixtures.stageFailureCases) {
    const request = clone(fixtures.baseRequest);
    request.stageResume.decisions[1] = {
      stageKey: "verify",
      decision: entry.decision,
      reasonCode: entry.reasonCode,
    };
    const plan = planV4PartialMutationRecovery(request);
    assert.equal(plan.classification, "escalate", entry.id);
    assert.equal(plan.unresolvedCheckpoint.kind, "stage-capsule");
    assert.equal(plan.unresolvedCheckpoint.id, "verify");
    assert.equal(plan.unresolvedCheckpoint.root, request.stageResume.planRoot);
    assert.deepEqual(
      plan.nextOperations.map(({ stepId }) => stepId),
      ["verify"],
    );
  }
});

test("binding, ambiguity, conflict, corruption, and unknown phases fail closed", () => {
  const policyDrift = clone(fixtures.baseRequest);
  policyDrift.stageResume.policyRoot = root("f");
  expectFault(policyDrift, "partial-mutation-recovery-binding-mismatch");

  const missing = clone(fixtures.baseRequest);
  missing.stageResume.qualificationRoots = [];
  expectFault(missing, "missing-partial-mutation-recovery-evidence");

  const corrupt = materializeCase(fixtures.cases[1]);
  corrupt.activation.steps[0].journalStateRoot = "not-a-root";
  expectFault(corrupt, "invalid-root");

  const conflicting = clone(fixtures.baseRequest);
  conflicting.activation.steps[0].journalRoot = root("0");
  expectFault(conflicting, "conflicting-partial-mutation-recovery-evidence");

  const duplicateOperation = clone(fixtures.baseRequest);
  duplicateOperation.activation.steps[1].operationRoot =
    duplicateOperation.activation.steps[0].operationRoot;
  expectFault(
    duplicateOperation,
    "conflicting-partial-mutation-recovery-evidence",
  );

  const unknown = clone(fixtures.baseRequest);
  unknown.activation.steps[0].phase = "maybe-applied";
  expectFault(unknown, "unknown-partial-mutation-recovery-phase");

  const reordered = clone(fixtures.baseRequest);
  reordered.activation.steps.reverse();
  expectFault(reordered, "unordered-partial-mutation-recovery-evidence");
});

test("real Stage Capsule restore and activation journal projections remain source, policy, platform, and qualification bound", () => {
  const resumeRequest = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/fixtures/v4-stage-capsule-resume-v1/late-platform-failure.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const activationRequest = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/fixtures/v4-release-activation-shadow-v1/shared.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const identity = resumeRequest.nodes[0].expectedIdentity;
  activationRequest.policyRoot = identity.policyRoot;
  for (const step of activationRequest.steps)
    step.operation.policyRoot = identity.policyRoot;
  const stagePlan = planV4StageCapsuleResume(resumeRequest);
  const activation = projectV4ReleaseActivation(activationRequest);
  const byId = new Map(activation.plan.steps.map((step) => [step.id, step]));
  const request = {
    schema: "buildchain-v4-partial-mutation-recovery-request/v1",
    evaluatedAt: resumeRequest.evaluatedAt,
    sourceRoot: identity.sourceRoot,
    policyRoot: identity.policyRoot,
    platformRoot: identity.platformRoot,
    qualificationRoot: activationRequest.qualificationRoot,
    maxAttempts: 3,
    compensableBoundaryRoots: [],
    stageResume: {
      schema: "buildchain-v4-stage-capsule-resume-evidence/v1",
      planRoot: stagePlan.planRoot,
      sourceRoot: identity.sourceRoot,
      policyRoot: identity.policyRoot,
      platformRoot: identity.platformRoot,
      qualificationRoots: [
        ...new Set(
          resumeRequest.nodes.map(
            ({ expectedIdentity }) => expectedIdentity.qualificationRoot,
          ),
        ),
      ].sort(),
      decisions: stagePlan.decisions
        .map(({ stageKey, decision, reasonCode }) => ({
          stageKey,
          decision,
          reasonCode,
        }))
        .sort((left, right) => left.stageKey.localeCompare(right.stageKey)),
    },
    activation: {
      schema: "buildchain-v4-release-activation-recovery-evidence/v1",
      planRoot: activation.plan.planRoot,
      stateRoot: activation.state.stateRoot,
      qualificationRoot: activationRequest.qualificationRoot,
      policyRoot: activationRequest.policyRoot,
      steps: activation.state.stepStates.map((state) => ({
        stepId: state.stepId,
        operationRoot: state.operationRoot,
        phase: state.phase,
        journalRoot: state.journalRoot,
        journalStateRoot: state.journalStateRoot,
        compensationBoundaryRoot: byId.get(state.stepId)
          .compensationBoundaryRoot,
        attemptCount: state.attemptCount,
      })),
    },
  };
  const plan = planV4PartialMutationRecovery(request);
  assert.equal(plan.classification, "escalate");
  assert.equal(plan.unresolvedCheckpoint.kind, "stage-capsule");
  assert.equal(plan.unresolvedCheckpoint.id, "verify");
  assert.equal(plan.sourceRoot, identity.sourceRoot);
  assert.equal(plan.policyRoot, identity.policyRoot);
  assert.equal(plan.platformRoot, identity.platformRoot);
  assert.equal(plan.qualificationRoot, activationRequest.qualificationRoot);
});

test("Rust and TypeScript emit byte-equivalent recovery decisions and roots", () => {
  const entry = fixtures.cases.find(
    ({ id }) => id === "partial-multi-provider",
  );
  const request = materializeCase(entry);
  const typescript = planV4PartialMutationRecovery(request);
  const result = spawnSync(
    process.platform === "win32" ? "cargo.exe" : "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-v4-contracts/Cargo.toml",
      "--",
      "partial-mutation-recovery",
      "-",
    ],
    {
      cwd: repositoryRoot,
      input: JSON.stringify(request),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), typescript);
});

test("the closed architecture contract keeps the qualification shadow-only and effect-free", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/v4-partial-mutation-recovery-v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const architecture = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/v4-partial-mutation-recovery-qualification.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.stageResume.additionalProperties, false);
  assert.equal(schema.$defs.activation.additionalProperties, false);
  assert.equal(architecture.mode, "shadow-only");
  assert.equal(architecture.productionAuthority, "typescript-v3");
  assert.equal(architecture.budgets.liveProviderMutations, 0);
  assert.equal(architecture.budgets.networkWrites, 0);
  assert.equal(architecture.budgets.credentialReads, 0);
  assert.equal(architecture.budgets.unboundedRetries, 0);
});

test("recovery implementations contain no provider, network, filesystem, process, credential, or ambient-clock authority", () => {
  const javascript = fs.readFileSync(
    new URL(
      "../packages/core/v4-partial-mutation-recovery-qualification.js",
      import.meta.url,
    ),
    "utf8",
  );
  const rust = fs.readFileSync(
    new URL(
      "../crates/buildchain-v4-contracts/src/partial_mutation_recovery.rs",
      import.meta.url,
    ),
    "utf8",
  );
  for (const forbidden of [
    "Date.now(",
    "new Date(",
    "node:fs",
    "node:https",
    "process.env",
    "fetch(",
    "child_process",
  ])
    assert.equal(javascript.includes(forbidden), false, forbidden);
  for (const forbidden of [
    "std::fs",
    "std::net",
    "std::process",
    "std::env",
    "SystemTime",
    "Instant::now",
    "reqwest",
    "octocrab",
    "git2",
  ])
    assert.equal(rust.includes(forbidden), false, forbidden);
});
