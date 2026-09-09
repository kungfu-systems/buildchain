#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectWorkflowJob, readWorkflow } from "./workflow-action-graph.mjs";

const INVENTORY_PATH = "architecture/release-tail-contract.json";
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function loadJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function read(root, file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function commandInputs(text, indent, stopAt = "") {
  const source = stopAt ? text.split(new RegExp(`^${stopAt}`, "mu"))[0] : text;
  const pattern = new RegExp(`^ {${indent}}([a-z0-9-]+-command):\\s*$`, "gmu");
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function workflowCoordinates(root, inventory) {
  return (inventory.reverseScan.workflowInputs || []).flatMap((file) =>
    commandInputs(read(root, file), 6, "jobs:").map(
      (name) => `workflow:${file}#${name}`,
    ),
  );
}

function actionCoordinates(root, inventory) {
  return (inventory.reverseScan.actionInputs || []).flatMap((file) =>
    commandInputs(read(root, file).split(/^outputs:/mu)[0], 2).map(
      (name) => `action:${file}#${name}`,
    ),
  );
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameSet(left, right) {
  return (
    JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right))
  );
}

function validateReverseScan(root, inventory, surfaces, issues) {
  const coordinates = [
    ...workflowCoordinates(root, inventory),
    ...actionCoordinates(root, inventory),
    ...(inventory.reverseScan.configAndCliCoordinates || []),
  ];
  const owned = new Map();
  for (const surface of surfaces) {
    if (Object.hasOwn(surface, "aliases"))
      issues.push(`${surface.id}: command aliases are forbidden`);
    for (const coordinate of surface.coordinates || []) {
      if (owned.has(coordinate))
        issues.push(
          `${coordinate}: ambiguous surface ownership (${owned.get(coordinate)}, ${surface.id})`,
        );
      owned.set(coordinate, surface.id);
    }
  }
  for (const coordinate of coordinates) {
    if (!owned.has(coordinate))
      issues.push(`unclassified release-tail command surface: ${coordinate}`);
  }
  for (const coordinate of owned.keys()) {
    if (!coordinates.includes(coordinate))
      issues.push(
        `declared release-tail coordinate is not reverse-discovered: ${coordinate}`,
      );
  }

  const workflowNames = coordinates
    .filter((entry) => entry.startsWith("workflow:"))
    .map((entry) => entry.split("#")[1]);
  const actionNames = coordinates
    .filter((entry) => entry.startsWith("action:"))
    .map((entry) => entry.split("#")[1]);
  if (!sameSet(workflowNames, inventory.reverseScan.workflowCommandNames || []))
    issues.push("reverse scan workflow command-name inventory drifted");
  if (!sameSet(actionNames, inventory.reverseScan.actionCommandNames || []))
    issues.push("reverse scan Action command-name inventory drifted");

  let executionSites = 0;
  for (const surface of surfaces) {
    for (const site of surface.executionSites || []) {
      const file = path.join(root, site.path || "");
      if (!site.path || !site.marker || !fs.existsSync(file)) {
        issues.push(
          `${surface.id}: execution site is incomplete: ${site.path || "<empty>"}`,
        );
        continue;
      }
      if (!fs.readFileSync(file, "utf8").includes(site.marker))
        issues.push(
          `${surface.id}: execution marker is missing from ${site.path}`,
        );
      executionSites += 1;
    }
  }
  return { coordinates: coordinates.length, executionSites };
}

function validateTransaction(inventory, issues) {
  const transaction = inventory.canonicalTransaction || {};
  const phases = (transaction.phases || []).map((entry) => entry.id);
  if (
    transaction.id !== "buildchain.release-tail/v1" ||
    transaction.singleWriter !== true
  )
    issues.push(
      "canonical release transaction identity or single-writer invariant is invalid",
    );
  if (
    !sameSet(phases, [
      "prepare",
      "publish",
      "commit",
      "activate",
      "readback",
      "settle",
    ])
  )
    issues.push("canonical release transaction must own all six frozen phases");
  if (
    transaction.effectSchema !== "kungfu.buildchain.release-tail.effect/v1" ||
    transaction.observationSchema !==
      "kungfu.buildchain.release-tail.observation/v1" ||
    transaction.receiptSchema !== "kungfu.buildchain.release-tail.receipt/v1"
  )
    issues.push("canonical effect, observation, and receipt schemas drifted");
  if ((transaction.retryClasses || []).some((entry) => entry.localAttempts > 3))
    issues.push("canonical transaction permits unbounded local retry");
  for (const terminal of [
    "complete",
    "blocked",
    "repair-required",
    "terminal-failure",
  ]) {
    if (!(transaction.terminalClasses || []).includes(terminal))
      issues.push(`canonical transaction omits terminal class ${terminal}`);
  }
  for (const forbidden of [
    "choose transaction transitions",
    "execute repository-supplied shell",
  ]) {
    if (!(transaction.adapterBoundary?.mustNot || []).includes(forbidden))
      issues.push(`adapter boundary omits ${forbidden}`);
  }
}

function findForbiddenKey(value, forbidden, at = "$") {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findForbiddenKey(entry, forbidden, `${at}[${index}]`);
      if (found) return found;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  for (const [key, entry] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) return `${at}.${key}`;
    const found = findForbiddenKey(entry, forbidden, `${at}.${key}`);
    if (found) return found;
  }
  return "";
}

function validateCapabilityMessages(
  inventory,
  capability,
  fixturePath,
  issues,
) {
  if (
    capability.effect?.schema !==
      inventory.canonicalTransaction?.effectSchema ||
    capability.observation?.schema !==
      inventory.canonicalTransaction?.observationSchema ||
    capability.receipt?.schema !== inventory.canonicalTransaction?.receiptSchema
  )
    issues.push(`${fixturePath}: ${capability.id} message schema drifted`);
}

function validateCapabilityOperation(capability, fixturePath, issues) {
  if (
    !ROOT_PATTERN.test(capability.operationIdentity?.transactionRoot || "") ||
    capability.operationIdentity?.capabilityId !== capability.id ||
    !ROOT_PATTERN.test(capability.operationIdentity?.subjectRoot || "") ||
    !ROOT_PATTERN.test(capability.operationIdentity?.targetRoot || "") ||
    !String(capability.operationIdentity?.attemptKey || "").trim()
  )
    issues.push(
      `${fixturePath}: ${capability.id} operation identity is incomplete or inconsistent`,
    );
  if (
    !Number.isInteger(capability.retry?.localAttempts) ||
    capability.retry.localAttempts < 0 ||
    capability.retry.localAttempts > 3
  )
    issues.push(`${fixturePath}: ${capability.id} local retry is invalid`);
}

function validateCapabilityDimensions(
  inventory,
  capability,
  fixturePath,
  issues,
) {
  for (const field of inventory.declarativeContract.requiredDimensions || []) {
    if (capability[field] === undefined)
      issues.push(`${fixturePath}: ${capability.id} omits ${field}`);
  }
  if (!(capability.readbackPredicates || []).length)
    issues.push(`${fixturePath}: ${capability.id} has no readback predicate`);
  if (!(capability.evidenceRequirements || []).length)
    issues.push(`${fixturePath}: ${capability.id} has no evidence requirement`);
}

function validateCapabilityFixture(inventory, fixture, fixturePath, issues) {
  const contract = inventory.declarativeContract || {};
  if (
    fixture.contract !== contract.contract ||
    fixture.schemaVersion !== contract.schemaVersion ||
    fixture.transactionPolicy !== inventory.canonicalTransaction?.id
  )
    issues.push(`${fixturePath}: declaration identity is invalid`);
  if (!SHA_PATTERN.test(fixture.subject?.sourceSha || ""))
    issues.push(`${fixturePath}: subject sourceSha is not exact`);
  const forbidden = new Set(contract.forbiddenKeys || []);
  const forbiddenPath = findForbiddenKey(fixture, forbidden);
  if (forbiddenPath)
    issues.push(
      `${fixturePath}: executable key is forbidden at ${forbiddenPath}`,
    );

  const capabilities = fixture.capabilities || [];
  const ids = capabilities.map((entry) => entry.id);
  if (!sameSet(ids, contract.requiredCapabilityIds || []))
    issues.push(`${fixturePath}: required capability set drifted`);
  if (ids.length !== new Set(ids).size)
    issues.push(`${fixturePath}: capability ids must be unique`);
  for (const capability of capabilities) {
    validateCapabilityDimensions(inventory, capability, fixturePath, issues);
    validateCapabilityMessages(inventory, capability, fixturePath, issues);
    validateCapabilityOperation(capability, fixturePath, issues);
  }
}

function validateContract(root, inventory, issues) {
  const contract = inventory.declarativeContract || {};
  if (!fs.existsSync(path.join(root, contract.schemaPath || "")))
    issues.push("declarative release-tail schema path is missing");
  else {
    const schema = loadJson(root, contract.schemaPath);
    if (
      schema.properties?.contract?.const !== contract.contract ||
      schema.properties?.schemaVersion?.const !== contract.schemaVersion
    )
      issues.push("declarative release-tail JSON Schema identity drifted");
  }
  for (const fixturePath of contract.fixturePaths || []) {
    if (!fs.existsSync(path.join(root, fixturePath))) {
      issues.push(`declarative fixture is missing: ${fixturePath}`);
      continue;
    }
    validateCapabilityFixture(
      inventory,
      loadJson(root, fixturePath),
      fixturePath,
      issues,
    );
  }
}

function validateSurfaceInventory(inventory, issues) {
  const surfaces = inventory.executableSurfaces || [];
  const surfaceIds = new Set();
  for (const surface of surfaces) {
    if (!surface.id || surfaceIds.has(surface.id))
      issues.push(
        `release-tail surface id is missing or duplicated: ${surface.id || "<empty>"}`,
      );
    surfaceIds.add(surface.id);
    for (const field of ["owner", "classification", "default", "disposition"]) {
      if (!String(surface[field] || "").trim())
        issues.push(`${surface.id}: ${field} is empty`);
    }
    if (!(surface.publicNames || []).length)
      issues.push(`${surface.id}: publicNames is empty`);
    if (!(surface.coordinates || []).length)
      issues.push(`${surface.id}: coordinates is empty`);
  }
  return { surfaces, surfaceIds };
}

function validateOwnedCallers(root, inventory, surfaceIds, issues) {
  for (const caller of inventory.ownedCallers || []) {
    if (!caller.id || !caller.workflow || !caller.action) {
      issues.push("owned release-tail caller is incomplete");
      continue;
    }
    const workflow = readWorkflow(caller.workflow, root);
    const reachable = Object.keys(workflow.jobs).some((jobId) =>
      inspectWorkflowJob(caller.workflow, jobId, root).actions.has(
        caller.action,
      ),
    );
    if (!reachable)
      issues.push(
        `${caller.id}: owned action is not reachable from its workflow`,
      );
    for (const surfaceId of caller.executableSurfaceIds || []) {
      if (!surfaceIds.has(surfaceId))
        issues.push(`${caller.id}: unknown executable surface ${surfaceId}`);
    }
  }
}

function validateInventory(root, inventory, issues) {
  if (
    inventory.schemaVersion !== 1 ||
    inventory.contract !== "buildchain.release-tail-contract/v1"
  )
    issues.push("release-tail inventory identity is invalid");
  if (
    !SHA_PATTERN.test(inventory.sourceCut?.protectedDevelopmentSeed || "") ||
    inventory.sourceCut?.implementation !== "working-tree"
  )
    issues.push("release-tail inventory must identify its current source cut");
  const { surfaces, surfaceIds } = validateSurfaceInventory(inventory, issues);
  validateOwnedCallers(root, inventory, surfaceIds, issues);
  return surfaces;
}

function validateCurrentBoundary(root, inventory, issues) {
  const boundary = inventory.currentBoundary || {};
  if (
    Object.hasOwn(inventory, "migration") ||
    Object.hasOwn(inventory, "legacyExecutableSurfaces")
  )
    issues.push(
      "historical migration policy cannot authorize the current release-tail contract",
    );
  if (
    boundary.compatibilityFallback !== false ||
    boundary.commandAliases !== false
  )
    issues.push(
      "current release-tail boundary forbids compatibility fallbacks and command aliases",
    );
  for (const kind of ["request", "invocation"]) {
    const schema = loadJson(root, `contracts/promotion-${kind}-v1.schema.json`);
    for (const field of boundary.retiredRequestFields || []) {
      if (Object.hasOwn(schema.properties, field))
        issues.push(`retired promotion command field: ${field}`);
    }
  }
  const graph = inspectWorkflowJob(boundary.canonicalPublisher, "apply", root);
  if (
    !graph.actions.has("actions/release/promote-candidate") ||
    [...graph.modules.keys()].some((file) => file.includes("/promote-ref/"))
  )
    issues.push(
      "canonical publisher must reach only its current provider transaction",
    );
  for (const step of graph.steps) {
    for (const field of boundary.retiredRequestFields || []) {
      if (Object.hasOwn(step.with || {}, field))
        issues.push(`canonical APPLY forwards a retired command: ${field}`);
    }
  }
}

function checkReleaseTailContract({
  root = process.cwd(),
  inventory = loadJson(root, INVENTORY_PATH),
  fixtures,
} = {}) {
  const issues = [];
  const surfaces = validateInventory(root, inventory, issues);
  validateTransaction(inventory, issues);
  if (fixtures) {
    for (const [fixturePath, fixture] of Object.entries(fixtures))
      validateCapabilityFixture(inventory, fixture, fixturePath, issues);
  } else {
    validateContract(root, inventory, issues);
  }
  const reverseScan = validateReverseScan(root, inventory, surfaces, issues);
  validateCurrentBoundary(root, inventory, issues);
  if (issues.length)
    throw new Error(
      `release-tail contract check failed:\n- ${issues.join("\n- ")}`,
    );
  return {
    surfaces: surfaces.length,
    ownedCallers: inventory.ownedCallers.length,
    capabilities: inventory.declarativeContract.requiredCapabilityIds.length,
    ...reverseScan,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const report = checkReleaseTailContract();
    console.log(
      `release-tail contract check passed: ${report.surfaces} classified surfaces, ${report.coordinates} reverse-discovered coordinates, ${report.executionSites} execution sites, ${report.capabilities} declarative capabilities, ${report.ownedCallers} owned callers`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { checkReleaseTailContract };
