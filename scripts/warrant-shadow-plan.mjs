#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { devDeliveryContentRoot } from "../packages/core/dev-delivery/dev-delivery-warrant.js";

const PLAN_PATH = "architecture/delivery-warrant-shadow-bootstrap-plan.json";
const PLAN_SCHEMA_PATH =
  "architecture/delivery-warrant-shadow-bootstrap-plan.schema.json";
const FIXTURES_PATH = "architecture/delivery-warrant-shadow-fixtures.json";
const FIXTURES_SCHEMA_PATH =
  "architecture/delivery-warrant-shadow-fixtures.schema.json";
const MANIFEST_PATH = "architecture/capability-state-machine-manifest.json";
const BOOTSTRAP_PATH = "architecture/bootstrap-authority.json";
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
      plan.legacyAuthority.writer === "typescript-v3",
      "plan must retain the qualified v3 comparison writer",
      issues,
    );
    required(
      machine.writer.runtime === "typescript-v4" &&
        machine.migrationPhase === "legacy-retired",
      "manifest must close the v4 writer cutover",
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

const HISTORY_PATH = new URL(
  "../architecture/history/warrant-shadow-observations.json",
  import.meta.url,
);
const HISTORICAL_SOURCE = "1bb6333b97ad94e94a81178e956a703dff2b5f84";
function readHistoricalObservations() {
  const document = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  if (
    document.schema !== "buildchain.warrant-historical-observations/v1" ||
    document.sourceCommit !== HISTORICAL_SOURCE
  )
    throw new Error("Warrant historical observation provenance drift");
  const source = execFileSync(
    "git",
    ["show", `${HISTORICAL_SOURCE}:scripts/warrant-shadow-plan.mjs`],
    { cwd: new URL("..", import.meta.url), maxBuffer: 1024 * 1024 },
  );
  if (
    crypto.createHash("sha256").update(source).digest("hex") !==
    document.producerSha256
  )
    throw new Error("Warrant historical producer digest drift");
  return document.traces;
}

function validateFixtures(fixtures) {
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
  const observations = readHistoricalObservations();
  const results = (fixtures.traces || []).map((trace) => {
    const observed = observations.find((entry) => entry.trace.id === trace.id);
    if (
      !observed ||
      devDeliveryContentRoot(observed.trace) !== devDeliveryContentRoot(trace)
    )
      throw new Error(
        `${trace.id} historical projection drift: input trace changed`,
      );
    if (
      devDeliveryContentRoot(observed.result.projections) !==
      observed.result.projectionRoot
    )
      throw new Error(
        `${trace.id} historical projection drift: observation bytes changed`,
      );
    return observed.result;
  });
  for (const [index, result] of results.entries()) {
    const expected = fixtures.traces[index].expectedLegacyProjectionRoot;
    required(
      ROOT_PATTERN.test(expected),
      `${result.id} expected root is invalid`,
      issues,
    );
    {
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

function loadWarrantPlan(root = process.cwd()) {
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
  const fixtureResults = validateFixtures(fixtures);
  return { plan, fixtures, report, fixtureResults };
}

function runCli(args = []) {
  const [command = "validate"] = args;
  const root = process.cwd();
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

export { loadWarrantPlan, validateFixtures, validatePlan };
