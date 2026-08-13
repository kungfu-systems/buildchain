#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_PATH = "architecture/v4-capability-state-machine-manifest.json";
const MANIFEST_SCHEMA_PATH =
  "architecture/v4-capability-state-machine-manifest.schema.json";
const EXCEPTION_PATH = "architecture/v4-exception-ledger.json";
const EXCEPTION_SCHEMA_PATH = "architecture/v4-exception-ledger.schema.json";
const BOOTSTRAP_PATH = "architecture/v4-bootstrap-authority.json";
const BUDGET_DIMENSIONS = Object.freeze([
  "authority",
  "semanticState",
  "boundary",
  "structural",
  "agentCognitive",
  "recoveryFault",
]);
const MIGRATION_PHASES = new Set([
  "legacy-authoritative",
  "shadow",
  "cutover-ready",
  "rust-authoritative",
  "legacy-retired",
]);

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function requiredString(value, coordinate, issues) {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${coordinate} must be a non-empty string`);
  }
}

function requiredStringArray(value, coordinate, issues) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${coordinate} must be a non-empty array`);
    return;
  }
  value.forEach((entry, index) =>
    requiredString(entry, `${coordinate}[${index}]`, issues),
  );
}

function uniqueIds(entries, coordinate, issues) {
  const ids = new Set();
  for (const [index, entry] of (entries || []).entries()) {
    requiredString(entry?.id, `${coordinate}[${index}].id`, issues);
    if (ids.has(entry?.id))
      issues.push(`${coordinate} has duplicate id: ${entry.id}`);
    ids.add(entry?.id);
  }
  return ids;
}

function dependencyCycles(layers) {
  const graph = new Map(
    layers.map((layer) => [layer.id, new Set(layer.mayDependOn || [])]),
  );
  const cycles = [];
  const complete = new Set();
  const active = new Set();
  const stack = [];
  const visit = (id) => {
    if (active.has(id)) {
      cycles.push([...stack.slice(stack.indexOf(id)), id]);
      return;
    }
    if (complete.has(id)) return;
    active.add(id);
    stack.push(id);
    for (const target of graph.get(id) || []) visit(target);
    stack.pop();
    active.delete(id);
    complete.add(id);
  };
  for (const id of graph.keys()) visit(id);
  return cycles;
}

function validateSchemaDocuments(manifestSchema, exceptionSchema, issues) {
  for (const [name, schema] of [
    [MANIFEST_SCHEMA_PATH, manifestSchema],
    [EXCEPTION_SCHEMA_PATH, exceptionSchema],
  ]) {
    if (schema?.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      issues.push(`${name} must use JSON Schema draft 2020-12`);
    }
    requiredString(schema?.$id, `${name}.$id`, issues);
    if (schema?.type !== "object" || schema?.additionalProperties !== false) {
      issues.push(`${name} must be a closed object schema`);
    }
  }
}

function validateExceptionLedger(ledger, issues) {
  if (ledger?.schemaVersion !== 1)
    issues.push("exception ledger schemaVersion must be 1");
  if (
    ledger?.contract !== "kungfu-buildchain-v4-architecture-exception-ledger"
  ) {
    issues.push("exception ledger contract is invalid");
  }
  if (!Array.isArray(ledger?.exceptions)) {
    issues.push("exception ledger exceptions must be an array");
    return;
  }
  const ids = new Set();
  for (const [index, entry] of ledger.exceptions.entries()) {
    const coordinate = `exceptions[${index}]`;
    for (const field of [
      "id",
      "status",
      "owner",
      "budgetDimension",
      "scope",
      "rationale",
      "expiresAt",
      "removalCondition",
    ]) {
      requiredString(entry?.[field], `${coordinate}.${field}`, issues);
    }
    if (ids.has(entry?.id))
      issues.push(`duplicate architecture exception: ${entry.id}`);
    ids.add(entry?.id);
    if (!BUDGET_DIMENSIONS.includes(entry?.budgetDimension)) {
      issues.push(`${coordinate}.budgetDimension is invalid`);
    }
    if (!["active", "closed"].includes(entry?.status)) {
      issues.push(`${coordinate}.status is invalid`);
    }
    if (!Array.isArray(entry?.evidence) || entry.evidence.length === 0) {
      issues.push(`${coordinate}.evidence must be non-empty`);
    }
    if (Number.isNaN(Date.parse(entry?.expiresAt || ""))) {
      issues.push(`${coordinate}.expiresAt must be an ISO-8601 timestamp`);
    }
  }
}

function validateBudgets(budgets, issues) {
  for (const dimension of BUDGET_DIMENSIONS) {
    const ceilings = budgets?.[dimension]?.hardCeilings;
    if (!ceilings || typeof ceilings !== "object" || Array.isArray(ceilings)) {
      issues.push(`budgets.${dimension}.hardCeilings must be an object`);
      continue;
    }
    for (const [name, value] of Object.entries(ceilings)) {
      if (!Number.isInteger(value) || value < 0) {
        issues.push(
          `budgets.${dimension}.${name} must be a non-negative integer`,
        );
      }
    }
  }
  const hardZero = [
    ["authority", "undeclaredAuthorities"],
    ["authority", "permanentDualWrites"],
    ["authority", "crossMachineMutableFiles"],
    ["semanticState", "undeclaredStates"],
    ["semanticState", "undeclaredEvents"],
    ["semanticState", "bypassTransitions"],
    ["boundary", "providerSdkImportsInContracts"],
    ["boundary", "providerSdkImportsInRustDomain"],
    ["boundary", "dependencyCycles"],
    ["structural", "unownedSourceFiles"],
    ["structural", "unmappedCapabilities"],
    ["structural", "manualProjectionCopies"],
    ["agentCognitive", "duplicateArchitectureExplanations"],
    ["agentCognitive", "implicitAuthorityDecisions"],
    ["recoveryFault", "stateMachinesWithoutRecovery"],
    ["recoveryFault", "unboundedRetries"],
    ["recoveryFault", "unknownFailureClasses"],
  ];
  for (const [dimension, name] of hardZero) {
    if (budgets?.[dimension]?.hardCeilings?.[name] !== 0) {
      issues.push(`hard-zero budget was widened: ${dimension}.${name}`);
    }
  }
  if (budgets?.authority?.hardCeilings?.writersPerStateMachine !== 1) {
    issues.push("authority.writersPerStateMachine must remain exactly 1");
  }
}

function validateDependencyLayers(layers, issues) {
  if (!Array.isArray(layers) || layers.length === 0) {
    issues.push("dependencyLayers must be non-empty");
    return;
  }
  const layerIds = uniqueIds(layers, "dependencyLayers", issues);
  for (const [index, layer] of layers.entries()) {
    if (!Array.isArray(layer?.mayDependOn))
      issues.push(`dependencyLayers[${index}].mayDependOn must be an array`);
    for (const target of layer?.mayDependOn || []) {
      if (!layerIds.has(target))
        issues.push(`${layer.id} depends on unknown layer: ${target}`);
      if (target === layer.id)
        issues.push(`${layer.id} cannot depend on itself`);
    }
    if (
      ["contracts", "rust-domain"].includes(layer?.id) &&
      layer?.providerSdkImports !== "forbidden"
    )
      issues.push(`${layer.id} must forbid provider SDK imports`);
  }
  for (const cycle of dependencyCycles(layers))
    issues.push(`dependency layer cycle: ${cycle.join(" -> ")}`);
}

function validateCapabilities(capabilities, inventory, issues) {
  if (!Array.isArray(capabilities) || capabilities.length === 0)
    issues.push("capabilities must be non-empty");
  const capabilityIds = uniqueIds(capabilities || [], "capabilities", issues);
  const inventoryById = new Map(
    (inventory?.mechanisms || []).map((entry) => [entry.id, entry]),
  );
  for (const [index, capability] of (capabilities || []).entries()) {
    requiredString(capability?.owner, `capabilities[${index}].owner`, issues);
    requiredStringArray(
      capability?.surfaces,
      `capabilities[${index}].surfaces`,
      issues,
    );
    const source = inventoryById.get(capability?.sourceInventoryId);
    if (!source)
      issues.push(`${capability?.id} has unknown v3 source inventory id`);
    else {
      if (capability.owner !== source.owner)
        issues.push(`${capability.id} owner drifted from the v3 inventory`);
      for (const surface of capability.surfaces || [])
        if (!source.publicSurfaces.includes(surface))
          issues.push(`${capability.id} has undeclared v3 surface: ${surface}`);
    }
    if (!MIGRATION_PHASES.has(capability?.migrationPhase))
      issues.push(`${capability?.id} has invalid migrationPhase`);
    if (capability?.migrationPhase !== "legacy-retired")
      issues.push(`${capability?.id} must retire its legacy v3 authority`);
  }
  for (const id of inventoryById.keys()) {
    if (!(capabilities || []).some((entry) => entry.sourceInventoryId === id))
      issues.push(`v3 mechanism is absent from v4 capability manifest: ${id}`);
  }
  return capabilityIds;
}

function validateStateMachines(machines, capabilityIds, issues) {
  if (!Array.isArray(machines) || machines.length === 0)
    issues.push("stateMachines must be non-empty");
  uniqueIds(machines || [], "stateMachines", issues);
  for (const [index, machine] of (machines || []).entries()) {
    const coordinate = `stateMachines[${index}]`;
    if (!capabilityIds.has(machine?.capabilityId))
      issues.push(`${machine?.id} names unknown capabilityId`);
    requiredString(machine?.owner, `${coordinate}.owner`, issues);
    requiredString(machine?.store, `${coordinate}.store`, issues);
    for (const field of [
      "schemas",
      "states",
      "events",
      "invariants",
      "effects",
      "adapters",
      "tests",
      "recovery",
    ])
      requiredStringArray(machine?.[field], `${coordinate}.${field}`, issues);
    if (
      machine?.writer?.authoritative !== true ||
      machine?.writer?.secondWriterBudget !== 0
    )
      issues.push(
        `${machine?.id} must retain one authoritative writer and zero second-writer budget`,
      );
    requiredString(
      machine?.writer?.runtime,
      `${coordinate}.writer.runtime`,
      issues,
    );
    if (machine?.writer?.runtime !== "typescript-v4")
      issues.push(`${machine?.id} writer.runtime must be typescript-v4`);
    if (!MIGRATION_PHASES.has(machine?.migrationPhase))
      issues.push(`${machine?.id} has invalid migrationPhase`);
    if (machine?.migrationPhase !== "legacy-retired")
      issues.push(`${machine?.id} must retire its legacy v3 writer`);
    for (const field of [
      "undeclaredStates",
      "undeclaredEvents",
      "unboundedRetries",
    ])
      if (machine?.budgets?.[field] !== 0)
        issues.push(`${machine?.id}.${field} must remain zero`);
  }
}

function validateManifest({ manifest, inventory, bootstrap, ledger }) {
  const issues = [];
  if (manifest?.schemaVersion !== 1)
    issues.push("manifest schemaVersion must be 1");
  if (
    manifest?.contract !==
    "kungfu-buildchain-v4-capability-state-machine-manifest"
  )
    issues.push("manifest contract is invalid");
  if (manifest?.releaseLine?.branch !== "dev/v4/v4.0")
    issues.push("releaseLine.branch must be dev/v4/v4.0");
  if (manifest?.releaseLine?.productionAuthority !== "v4-native")
    issues.push("releaseLine.productionAuthority must be v4-native");
  if (manifest?.releaseLine?.productionFallback !== null)
    issues.push("releaseLine.productionFallback must be null after cutover");
  if (manifest?.releaseLine?.rollbackRef !== "release/v3/v3.0")
    issues.push("releaseLine.rollbackRef must retain release/v3/v3.0");
  if (
    manifest?.releaseLine?.qualificationMode !==
    "exact-n-minus-one-git-revision"
  )
    issues.push(
      "releaseLine.qualificationMode must be exact-n-minus-one-git-revision",
    );
  if (manifest?.exceptionLedger !== EXCEPTION_PATH)
    issues.push(`manifest exceptionLedger must be ${EXCEPTION_PATH}`);
  if (bootstrap?.contract !== "kungfu-buildchain-v4-bootstrap-authority")
    issues.push("bootstrap authority contract is invalid");
  if (bootstrap?.releaseLine?.candidateBranch !== manifest?.releaseLine?.branch)
    issues.push(
      "bootstrap candidate branch does not match manifest release line",
    );
  validateBudgets(manifest?.budgets, issues);
  validateExceptionLedger(ledger, issues);
  validateDependencyLayers(manifest?.dependencyLayers, issues);
  const capabilityIds = validateCapabilities(
    manifest?.capabilities,
    inventory,
    issues,
  );
  validateStateMachines(manifest?.stateMachines, capabilityIds, issues);
  if (issues.length > 0)
    throw new Error(
      `v4 architecture validation failed:\n- ${issues.join("\n- ")}`,
    );
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-architecture-validation",
    ok: true,
    releaseLine: manifest.releaseLine.branch,
    capabilities: manifest.capabilities.length,
    stateMachines: manifest.stateMachines.length,
    dependencyLayers: manifest.dependencyLayers.length,
    dependencyCycles: 0,
    activeExceptions: ledger.exceptions.filter(
      (entry) => entry.status === "active",
    ).length,
    productionWriterMigrations: manifest.stateMachines.filter(
      (entry) => entry.migrationPhase !== "legacy-authoritative",
    ).length,
  };
}

function loadArchitecture(root = process.cwd()) {
  const manifestSchema = readJson(root, MANIFEST_SCHEMA_PATH);
  const exceptionSchema = readJson(root, EXCEPTION_SCHEMA_PATH);
  const manifest = readJson(root, MANIFEST_PATH);
  const ledger = readJson(root, EXCEPTION_PATH);
  const bootstrap = readJson(root, BOOTSTRAP_PATH);
  const inventory = readJson(
    root,
    "architecture/v3-core-mechanism-inventory.json",
  );
  const schemaIssues = [];
  validateSchemaDocuments(manifestSchema, exceptionSchema, schemaIssues);
  if (schemaIssues.length > 0) {
    throw new Error(
      `v4 architecture schema validation failed:\n- ${schemaIssues.join("\n- ")}`,
    );
  }
  const report = validateManifest({ manifest, inventory, bootstrap, ledger });
  return { manifest, ledger, bootstrap, report };
}

function architectureList(root = process.cwd()) {
  const { manifest, report } = loadArchitecture(root);
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-architecture-list",
    source: MANIFEST_PATH,
    releaseLine: report.releaseLine,
    capabilities: manifest.capabilities.map((entry) => ({
      id: entry.id,
      owner: entry.owner,
      migrationPhase: entry.migrationPhase,
      stateMachine: manifest.stateMachines.some(
        (machine) => machine.capabilityId === entry.id,
      ),
    })),
  };
}

function architectureShow(id, root = process.cwd()) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("architecture id must be a non-empty string");
  }
  const { manifest } = loadArchitecture(root);
  const capability = manifest.capabilities.find((entry) => entry.id === id);
  if (!capability) throw new Error(`unknown architecture capability: ${id}`);
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-architecture-show",
    source: MANIFEST_PATH,
    capability,
    stateMachines: manifest.stateMachines.filter(
      (entry) => entry.capabilityId === id,
    ),
    budgets: manifest.budgets,
  };
}

function gitJson(root, revision, relativePath) {
  return JSON.parse(
    execFileSync("git", ["show", `${revision}:${relativePath}`], {
      cwd: root,
      encoding: "utf8",
    }),
  );
}

function exactRevision(root, revision) {
  return execFileSync(
    "git",
    ["rev-parse", "--verify", `${revision}^{commit}`],
    {
      cwd: root,
      encoding: "utf8",
    },
  ).trim();
}

function compareNMinusOne({
  root = process.cwd(),
  authorityRevision,
  candidateRevision = "HEAD",
}) {
  if (
    typeof authorityRevision !== "string" ||
    authorityRevision.trim() === ""
  ) {
    throw new Error("authorityRevision must be a non-empty string");
  }
  const authority = exactRevision(root, authorityRevision);
  const candidate = exactRevision(root, candidateRevision);
  if (authority === candidate)
    throw new Error("N-1 qualification rejects candidate self-qualification");
  const ancestry = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", authority, candidate],
    { cwd: root },
  );
  if (ancestry.status !== 0)
    throw new Error(
      "candidate revision must descend from the N-1 authority revision",
    );
  const authorityManifest = gitJson(root, authority, MANIFEST_PATH);
  const candidateManifest = gitJson(root, candidate, MANIFEST_PATH);
  const authorityLedger = gitJson(root, authority, EXCEPTION_PATH);
  const candidateLedger = gitJson(root, candidate, EXCEPTION_PATH);
  for (const field of [
    "releaseLine",
    "dependencyLayers",
    "capabilities",
    "stateMachines",
  ]) {
    if (
      JSON.stringify(candidateManifest[field]) !==
      JSON.stringify(authorityManifest[field])
    )
      throw new Error(
        `candidate drifted from N-1 manifest authority: ${field}`,
      );
  }
  const deltas = [];
  for (const dimension of BUDGET_DIMENSIONS) {
    const prior = authorityManifest.budgets?.[dimension]?.hardCeilings || {};
    const next = candidateManifest.budgets?.[dimension]?.hardCeilings || {};
    for (const [name, candidateValue] of Object.entries(next)) {
      const authorityValue = prior[name];
      if (!Number.isInteger(authorityValue)) {
        throw new Error(
          `candidate introduced an unqualified budget: ${dimension}.${name}`,
        );
      }
      const direction =
        candidateValue === authorityValue
          ? "unchanged"
          : candidateValue < authorityValue
            ? "tightened"
            : "widened";
      deltas.push({
        dimension,
        name,
        authority: authorityValue,
        candidate: candidateValue,
        direction,
      });
      if (candidateValue > authorityValue) {
        throw new Error(
          `candidate widened N-1 ceiling: ${dimension}.${name} (${authorityValue} -> ${candidateValue})`,
        );
      }
    }
    for (const name of Object.keys(prior)) {
      if (!Object.hasOwn(next, name))
        throw new Error(`candidate removed N-1 budget: ${dimension}.${name}`);
    }
  }
  const authorityExceptions = new Map(
    authorityLedger.exceptions.map((entry) => [entry.id, entry]),
  );
  for (const entry of candidateLedger.exceptions.filter(
    (item) => item.status === "active",
  )) {
    const prior = authorityExceptions.get(entry.id);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(entry)) {
      throw new Error(
        `candidate created or broadened an N-1 qualification exception: ${entry.id}`,
      );
    }
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-n-minus-one-qualification",
    ok: true,
    authorityRevision: authority,
    candidateRevision: candidate,
    authoritySource: `git show ${authority}:${MANIFEST_PATH}`,
    candidateSelfQualified: false,
    frozenManifestFields: 4,
    budgetDeltas: deltas,
    activeExceptions: candidateLedger.exceptions.filter(
      (entry) => entry.status === "active",
    ).length,
  };
}

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || fallback;
}

function print(value, json = false) {
  process.stdout.write(`${JSON.stringify(value, null, json ? 2 : 0)}\n`);
}

function runArchitectureCli(args = []) {
  const [command = "validate", ...rest] = args;
  const root = path.resolve(flag(rest, "cwd", process.cwd()));
  const json = rest.includes("--json");
  if (command === "validate") return print(loadArchitecture(root).report, json);
  if (command === "list") return print(architectureList(root), json);
  if (command === "show") {
    const id = rest.find(
      (entry) => !entry.startsWith("--") && entry !== flag(rest, "cwd"),
    );
    if (!id)
      throw new Error(
        "usage: buildchain architecture show <capability-id> [--json]",
      );
    return print(architectureShow(id, root), json);
  }
  if (command === "qualify") {
    const authorityRevision = flag(rest, "authority-revision");
    if (!authorityRevision)
      throw new Error(
        "architecture qualify requires --authority-revision <git-revision>",
      );
    return print(
      compareNMinusOne({
        root,
        authorityRevision,
        candidateRevision: flag(rest, "candidate-revision", "HEAD"),
      }),
      json,
    );
  }
  throw new Error(`unsupported architecture command: ${command}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    runArchitectureCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      `buildchain architecture: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

export {
  architectureList,
  architectureShow,
  compareNMinusOne,
  loadArchitecture,
  validateManifest,
};
