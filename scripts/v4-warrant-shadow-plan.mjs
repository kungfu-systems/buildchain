#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  cancelQueuedDevDeliveryCandidate,
  closeDevDeliveryWarrant,
  createDevDeliveryQueue,
  devDeliveryContentRoot,
  heartbeatDevDeliveryWarrant,
  recoverExpiredDevDeliveryWarrant,
  selectDevDeliveryWarrant,
  settleDevDeliveryTerminalEvent,
  submitDevDeliveryCandidate,
} from "../packages/core/dev-delivery-warrant.js";

const PLAN_PATH = "architecture/v4-delivery-warrant-shadow-bootstrap-plan.json";
const PLAN_SCHEMA_PATH =
  "architecture/v4-delivery-warrant-shadow-bootstrap-plan.schema.json";
const FIXTURES_PATH = "architecture/v4-delivery-warrant-shadow-fixtures.json";
const FIXTURES_SCHEMA_PATH =
  "architecture/v4-delivery-warrant-shadow-fixtures.schema.json";
const MANIFEST_PATH = "architecture/v4-capability-state-machine-manifest.json";
const BOOTSTRAP_PATH = "architecture/v4-bootstrap-authority.json";
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REQUIRED_PRIMITIVES = [
  "canonical-json",
  "content-root",
  "expected-old",
  "explicit-clock",
  "decide-fold",
  "effects",
  "observations",
  "typed-retry",
  "receipts",
];
const REQUIRED_STAGES = [
  "legacy-authoritative-shadow",
  "legacy-authoritative-v4-read",
  "v4-authoritative-write",
  "legacy-removal",
];

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}
function required(condition, message, issues) {
  if (!condition) issues.push(message);
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}
function exactSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((entry, index) => entry === [...right].sort()[index])
  );
}
function validateSchemaDocument(schema, relativePath, issues) {
  required(
    schema?.$schema === "https://json-schema.org/draft/2020-12/schema",
    `${relativePath} must use JSON Schema draft 2020-12`,
    issues,
  );
  required(nonEmpty(schema?.$id), `${relativePath} must declare $id`, issues);
  required(
    schema?.type === "object" && schema?.additionalProperties === false,
    `${relativePath} must be a closed object schema`,
    issues,
  );
}

function dependencyCycles(nodes) {
  const graph = new Map(nodes.map((node) => [node.id, node.dependsOn]));
  const active = new Set();
  const done = new Set();
  const cycles = [];
  function visit(id, stack = []) {
    if (active.has(id)) {
      cycles.push([...stack.slice(stack.indexOf(id)), id]);
      return;
    }
    if (done.has(id)) return;
    active.add(id);
    for (const dependency of graph.get(id) || [])
      visit(dependency, [...stack, id]);
    active.delete(id);
    done.add(id);
  }
  for (const id of graph.keys()) visit(id);
  return cycles;
}

function validatePlan({ plan, manifest, bootstrap }) {
  const issues = [];
  required(plan?.schemaVersion === 1, "plan schemaVersion must be 1", issues);
  required(
    plan?.contract ===
      "kungfu-buildchain-v4-delivery-warrant-shadow-bootstrap-plan",
    "plan contract is invalid",
    issues,
  );
  required(
    plan?.releaseLine === "dev/v4/v4.0",
    "plan releaseLine must be dev/v4/v4.0",
    issues,
  );
  const machine = manifest.stateMachines.find(
    (entry) => entry.id === "dev-delivery-warrant",
  );
  required(
    Boolean(machine),
    "v4 manifest is missing dev-delivery-warrant",
    issues,
  );
  if (machine) {
    required(
      exactSet(plan.legacyAuthority.states, machine.states),
      "plan states must exactly cover the v3 inventory manifest",
      issues,
    );
    required(
      exactSet(plan.legacyAuthority.events, machine.events),
      "plan events must exactly cover the v3 inventory manifest",
      issues,
    );
    required(
      plan.legacyAuthority.writer === machine.writer.runtime,
      "plan must retain the manifest legacy writer",
      issues,
    );
  }
  const coveredStates = new Set(
    (plan.transitionMatrix || []).flatMap((entry) => entry.from),
  );
  const coveredEvents = new Set(
    (plan.transitionMatrix || []).map((entry) => entry.event),
  );
  for (const state of plan.legacyAuthority.states || []) {
    required(
      coveredStates.has(state),
      `transition matrix omits state ${state}`,
      issues,
    );
  }
  for (const event of plan.legacyAuthority.events || []) {
    required(
      coveredEvents.has(event),
      `transition matrix omits event ${event}`,
      issues,
    );
  }
  required(
    plan.canonicalContract.clock.mode === "explicit-input-only",
    "v4 clock must be explicit-input-only",
    issues,
  );
  required(
    plan.canonicalContract.json.objectKeys === "ascii-code-point-order",
    "canonical JSON key order must be frozen",
    issues,
  );
  required(
    exactSet(
      (plan.primitives || []).map((entry) => entry.id),
      REQUIRED_PRIMITIVES,
    ),
    "plan must declare the complete reusable primitive set",
    issues,
  );
  required(
    plan.boundaries.rustDomain.providerSdkImports === "forbidden",
    "Rust domain must forbid provider SDK imports",
    issues,
  );
  required(
    plan.authority.permanentDualAuthority === false,
    "permanent dual authority must be forbidden",
    issues,
  );
  required(
    plan.authority.candidateSelfQualification === false,
    "candidate self-qualification must be forbidden",
    issues,
  );
  required(
    plan.authority.bootstrap.sourceCommit ===
      bootstrap.releaseLine.sourceCommit &&
      plan.authority.bootstrap.bootstrapCommit ===
        bootstrap.releaseLine.bootstrapCommit,
    "plan bootstrap coordinates must match v4 bootstrap authority",
    issues,
  );
  required(
    exactSet(
      (plan.rollout || []).map((entry) => entry.id),
      REQUIRED_STAGES,
    ),
    "rollout stages must cover shadow, read, write, and legacy removal",
    issues,
  );
  for (const stage of plan.rollout || []) {
    for (const field of [
      "authority",
      "entry",
      "exit",
      "rollback",
      "evidence",
      "stopConditions",
    ]) {
      const value = stage[field];
      required(
        nonEmpty(value) || (Array.isArray(value) && value.length > 0),
        `rollout ${stage.id}.${field} must be non-empty`,
        issues,
      );
    }
  }
  for (const disagreement of plan.legacyDisagreements || []) {
    required(
      ["preserve-in-compatibility", "change-in-v4", "block-cutover"].includes(
        disagreement.disposition,
      ),
      `disagreement ${disagreement.id} has no explicit disposition`,
      issues,
    );
  }
  required(
    (plan.legacyDisagreements || []).length >= 5,
    "legacy disagreements must be explicit and source-grounded",
    issues,
  );
  const nodes = plan.wave1?.nodes || [];
  const nodeIds = new Set(nodes.map((entry) => entry.id));
  for (const node of nodes) {
    for (const dependency of node.dependsOn || []) {
      required(
        nodeIds.has(dependency),
        `Wave 1 node ${node.id} depends on unknown node ${dependency}`,
        issues,
      );
    }
  }
  for (const cycle of dependencyCycles(nodes))
    issues.push(`Wave 1 dependency cycle: ${cycle.join(" -> ")}`);
  // prettier-ignore
  required(JSON.stringify([plan.wave0Reconciliation?.children?.length, plan.wave0Reconciliation?.productionAuthority]) === '[4,"typescript-v3"]', "Wave 0 reconciliation must retain v3 authority", issues);
  // prettier-ignore
  required(JSON.stringify([plan.wave1?.entryGate, plan.wave1?.readCandidateEntryGate]) === '["wave0-reconciliation-proved","all-shadow-zero-diff-gates-pass"]', "Wave 1 entry gates must remain distinct", issues);
  if (issues.length > 0) {
    throw new Error(
      `v4 Warrant plan validation failed:\n- ${issues.join("\n- ")}`,
    );
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-delivery-warrant-plan-validation",
    ok: true,
    states: plan.legacyAuthority.states.length,
    events: plan.legacyAuthority.events.length,
    transitionRows: plan.transitionMatrix.length,
    primitives: plan.primitives.length,
    disagreements: plan.legacyDisagreements.length,
    rolloutStages: plan.rollout.length,
    wave1Nodes: nodes.length,
    permanentDualAuthority: false,
    candidateSelfQualification: false,
  };
}

const ROOTS = Object.fromEntries(
  [
    "assignment",
    "initiative",
    "patch",
    "proof",
    "plan",
    "closure",
    "dependency",
    "toolchain",
    "evidence",
  ].map((name, index) => [
    name,
    `sha256:${(index + 1).toString(16).repeat(64)}`,
  ]),
);

function fixtureCandidate(number, overrides = {}) {
  const digit = (number % 9) + 1;
  return {
    pullRequestNumber: number,
    sourceHead: digit.toString(16).repeat(40),
    assignmentRoot: ROOTS.assignment,
    initiativeRoot: ROOTS.initiative,
    sourceIdentityRoot: `sha256:${digit.toString(16).repeat(64)}`,
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

function classifyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/stale fencing token/u.test(message)) return "stale-fencing-token";
  if (/lease expired/u.test(message)) return "lease-expired";
  if (/stateRoot drift/u.test(message)) return "state-root-drift";
  return "unclassified-error";
}
function projection(step, before, queue, result = {}) {
  return {
    id: step.id,
    operation: step.operation,
    action:
      result.receipt?.action || result.receipt?.reason || result.action || null,
    errorCode: result.errorCode || null,
    expectedOldStateRoot:
      result.receipt?.expectedOldStateRoot || before.stateRoot,
    nextStateRoot: queue.stateRoot,
    receiptRoot: result.receiptRoot || null,
    generation: queue.generation,
    fencingCounter: queue.fencingCounter,
    activePullRequest: queue.activeWarrant?.pullRequestNumber || null,
    candidateStates: queue.candidates.map((candidate) => ({
      pullRequestNumber: candidate.pullRequestNumber,
      status: candidate.status,
      attempts: candidate.attempts,
      recoveries: candidate.recoveries,
    })),
  };
}

function runTrace(trace) {
  const initial = trace.create;
  let queue = createDevDeliveryQueue({
    repository: initial.repository,
    protectedBase: initial.protectedBase,
    policy: initial.policy,
    now: initial.now,
  });
  const warrants = new Map();
  const settlements = new Map();
  const roots = new Map([["initial", queue.stateRoot]]);
  const projections = [];
  for (const step of trace.steps) {
    const before = queue;
    let result;
    try {
      if (step.operation === "submit") {
        result = submitDevDeliveryCandidate(
          queue,
          fixtureCandidate(step.pullRequestNumber, step.overrides),
          { now: step.now },
        );
        queue = result.queue;
      } else if (step.operation === "select") {
        result = selectDevDeliveryWarrant(queue, {
          now: step.now,
          leaseSeconds: step.leaseSeconds,
        });
        queue = result.queue;
        if (step.saveWarrant) warrants.set(step.saveWarrant, result.warrant);
      } else if (step.operation === "heartbeat") {
        result = heartbeatDevDeliveryWarrant(
          queue,
          warrants.get(step.useWarrant),
          { now: step.now, leaseSeconds: step.leaseSeconds },
        );
        queue = result.queue;
      } else if (step.operation === "recover-expired") {
        result = recoverExpiredDevDeliveryWarrant(queue, { now: step.now });
        queue = result.queue;
      } else if (step.operation === "close") {
        result = closeDevDeliveryWarrant(queue, warrants.get(step.useWarrant), {
          outcome: step.outcome,
          evidenceRoot: ROOTS.evidence,
          reason: step.reason,
          now: step.now,
        });
        queue = result.queue;
      } else if (step.operation === "settle-not-applicable") {
        result = settleDevDeliveryTerminalEvent(
          queue,
          {
            pullRequestNumber: step.pullRequestNumber,
            sourceHead: step.sourceHead,
            outcome: step.outcome,
            reason: step.reason,
          },
          { now: step.now },
        );
        queue = result.queue;
      } else if (step.operation === "settle-active") {
        const warrant = warrants.get(step.useWarrant);
        const input = {
          pullRequestNumber: warrant.pullRequestNumber,
          sourceHead: warrant.sourceHead,
          fencingToken: warrant.fencingToken,
          leaseGeneration: warrant.generation,
          outcome: step.outcome,
          evidenceRoot: ROOTS.evidence,
          reason: step.reason,
        };
        result = settleDevDeliveryTerminalEvent(queue, input, {
          now: step.now,
        });
        queue = result.queue;
        settlements.set(step.saveSettlement, input);
      } else if (step.operation === "settle-duplicate") {
        result = settleDevDeliveryTerminalEvent(
          queue,
          settlements.get(step.useSettlement),
          { now: step.now },
        );
        queue = result.queue;
      } else if (step.operation === "cancel-queued") {
        const candidate = queue.candidates.find(
          (entry) => entry.pullRequestNumber === step.pullRequestNumber,
        );
        const input = {
          candidateId: candidate.candidateId,
          pullRequestNumber: candidate.pullRequestNumber,
          expectedSourceHead: candidate.sourceHead,
          observedSourceHead: step.observedSourceHead || candidate.sourceHead,
          eventAction: "closed",
          outcome: "cancelled",
          evidenceRoot: ROOTS.evidence,
          reason: step.reason,
        };
        result = cancelQueuedDevDeliveryCandidate(queue, input, {
          now: step.now,
        });
        queue = result.queue;
      } else if (step.operation === "expected-old") {
        const expected = roots.get(step.expectedRoot);
        result =
          expected === queue.stateRoot
            ? { action: "cas-accepted" }
            : { action: "cas-rejected", errorCode: "stale-expected-old" };
      } else if (step.operation === "response-loss-readback") {
        result = {
          action:
            roots.get(step.committedRoot) === queue.stateRoot
              ? "committed-readback"
              : "indeterminate-stop",
        };
      } else if (step.operation === "provider-conflict") {
        result = {
          action: "provider-conflict-stop",
          errorCode: "provider-conflict",
        };
      } else {
        throw new Error(`unsupported fixture operation: ${step.operation}`);
      }
      if (step.expectError) {
        throw new Error(`fixture step ${step.id} expected ${step.expectError}`);
      }
    } catch (error) {
      const errorCode = classifyError(error);
      if (!step.expectError || step.expectError !== errorCode) throw error;
      result = { errorCode };
      queue = before;
    }
    roots.set(step.id, queue.stateRoot);
    projections.push(projection(step, before, queue, result));
  }
  return {
    id: trace.id,
    projectionRoot: devDeliveryContentRoot(projections),
    projections,
  };
}

function validateFixtures(fixtures, { verifyRoots = true } = {}) {
  const issues = [];
  required(
    fixtures?.schemaVersion === 1,
    "fixtures schemaVersion must be 1",
    issues,
  );
  required(
    fixtures?.contract ===
      "kungfu-buildchain-v4-delivery-warrant-shadow-fixtures",
    "fixtures contract is invalid",
    issues,
  );
  required(
    fixtures?.canonicalization === "buildchain-canonical-json/v1",
    "fixtures must bind canonicalization v1",
    issues,
  );
  required(
    fixtures?.clock === "explicit-input-only",
    "fixtures must forbid ambient time",
    issues,
  );
  const results = (fixtures.traces || []).map(runTrace);
  for (const [index, result] of results.entries()) {
    const expected = fixtures.traces[index].expectedLegacyProjectionRoot;
    required(
      ROOT_PATTERN.test(expected),
      `${result.id} expected root is invalid`,
      issues,
    );
    if (verifyRoots) {
      required(
        result.projectionRoot === expected,
        `${result.id} projection drift: ${result.projectionRoot} != ${expected}`,
        issues,
      );
    }
  }
  if (issues.length > 0) {
    throw new Error(
      `v4 Warrant fixture validation failed:\n- ${issues.join("\n- ")}`,
    );
  }
  return results;
}

function loadWarrantPlan(
  root = process.cwd(),
  { verifyFixtureRoots = true } = {},
) {
  const planSchema = readJson(root, PLAN_SCHEMA_PATH);
  const fixturesSchema = readJson(root, FIXTURES_SCHEMA_PATH);
  const schemaIssues = [];
  validateSchemaDocument(planSchema, PLAN_SCHEMA_PATH, schemaIssues);
  validateSchemaDocument(fixturesSchema, FIXTURES_SCHEMA_PATH, schemaIssues);
  if (schemaIssues.length > 0) {
    throw new Error(
      `v4 Warrant schema validation failed:\n- ${schemaIssues.join("\n- ")}`,
    );
  }
  const plan = readJson(root, PLAN_PATH);
  const fixtures = readJson(root, FIXTURES_PATH);
  const report = validatePlan({
    plan,
    manifest: readJson(root, MANIFEST_PATH),
    bootstrap: readJson(root, BOOTSTRAP_PATH),
  });
  const fixtureResults = validateFixtures(fixtures, {
    verifyRoots: verifyFixtureRoots,
  });
  return { plan, fixtures, report, fixtureResults };
}

function runCli(args = []) {
  const [command = "validate"] = args;
  const root = process.cwd();
  if (command === "roots") {
    const { fixtureResults } = loadWarrantPlan(root, {
      verifyFixtureRoots: false,
    });
    process.stdout.write(
      `${JSON.stringify(
        fixtureResults.map(({ id, projectionRoot }) => ({
          id,
          projectionRoot,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command !== "validate")
    throw new Error(`unsupported command: ${command}`);
  const { report, fixtureResults } = loadWarrantPlan(root);
  process.stdout.write(
    `${JSON.stringify({ ...report, fixtureTraces: fixtureResults.length }, null, 2)}\n`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      `buildchain v4 Warrant plan: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

export { loadWarrantPlan, runTrace, validateFixtures, validatePlan };
