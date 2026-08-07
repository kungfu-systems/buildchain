#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INVENTORY_PATH = "architecture/release-tail-contract-inventory.json";
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
    ...(inventory.reverseScan.configAndCliAliases || []),
  ];
  const owned = new Map();
  for (const surface of surfaces) {
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
  const surfaces = inventory.legacyExecutableSurfaces || [];
  const surfaceIds = new Set();
  for (const surface of surfaces) {
    if (!surface.id || surfaceIds.has(surface.id))
      issues.push(
        `release-tail surface id is missing or duplicated: ${surface.id || "<empty>"}`,
      );
    surfaceIds.add(surface.id);
    for (const field of [
      "owner",
      "classification",
      "default",
      "replacement",
      "disposition",
    ]) {
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

function validateManagedCallers(inventory, surfaceIds, issues) {
  for (const caller of inventory.managedConsumerCallers || []) {
    if (
      !caller.id ||
      !caller.repository ||
      !caller.workflow ||
      !caller.runtimeRef
    )
      issues.push(
        `managed consumer caller is incomplete: ${caller.id || "<empty>"}`,
      );
    if (
      !SHA_PATTERN.test(caller.sourceCommit || "") ||
      !SHA_PATTERN.test(caller.sourceTree || "")
    )
      issues.push(`${caller.id}: managed consumer cut is not exact`);
    for (const surfaceId of caller.executableSurfaceIds || []) {
      if (!surfaceIds.has(surfaceId))
        issues.push(`${caller.id}: unknown executable surface ${surfaceId}`);
    }
  }
}

function validateInventory(inventory, issues) {
  if (
    inventory.schemaVersion !== 1 ||
    inventory.contract !== "kungfu-buildchain-release-tail-contract-inventory"
  )
    issues.push("release-tail inventory identity is invalid");
  if (
    !SHA_PATTERN.test(inventory.baseline?.commit || "") ||
    !SHA_PATTERN.test(inventory.baseline?.tree || "")
  )
    issues.push("release-tail baseline must bind an exact commit and tree");
  const { surfaces, surfaceIds } = validateSurfaceInventory(inventory, issues);
  validateManagedCallers(inventory, surfaceIds, issues);
  return surfaces;
}

function validateMigration(inventory, issues) {
  const migration = inventory.migration || {};
  const window = migration.compatibilityWindow || {};
  if (
    window.maximumDurationDays !== 90 ||
    window.maximumMinorLines !== 2 ||
    window.permanentEscapeHatch !== false
  )
    issues.push(
      "compatibility window is not bounded by time, minor lines, and no-escape policy",
    );
  if ((migration.publishedReleasePreservation || []).length < 3)
    issues.push("published-release preservation rules are incomplete");
  const codes = new Set(
    (migration.rejectionRules || []).map((entry) => entry.code),
  );
  for (const code of [
    "release-tail-command-forbidden",
    "release-tail-alias-collision",
    "release-tail-operation-id-missing",
    "release-tail-readback-missing",
    "release-tail-retry-unbounded",
  ]) {
    if (!codes.has(code)) issues.push(`migration rejection rules omit ${code}`);
  }
  const excepted = new Set(
    (migration.exceptionLedger || []).flatMap(
      (entry) => entry.surfaceIds || [],
    ),
  );
  for (const surface of inventory.legacyExecutableSurfaces || []) {
    if (
      surface.classification !== "adjacent-non-tail" &&
      !excepted.has(surface.id)
    )
      issues.push(
        `${surface.id}: compatibility exception has no owner and sunset test`,
      );
  }
  for (const exception of migration.exceptionLedger || []) {
    if (!exception.owner || !exception.expires || !exception.removalTest)
      issues.push(`${exception.id}: exception ledger entry is incomplete`);
  }
}

function checkReleaseTailContract({
  root = process.cwd(),
  inventory = loadJson(root, INVENTORY_PATH),
  fixtures,
} = {}) {
  const issues = [];
  const surfaces = validateInventory(inventory, issues);
  validateTransaction(inventory, issues);
  if (fixtures) {
    for (const [fixturePath, fixture] of Object.entries(fixtures))
      validateCapabilityFixture(inventory, fixture, fixturePath, issues);
  } else {
    validateContract(root, inventory, issues);
  }
  const reverseScan = validateReverseScan(root, inventory, surfaces, issues);
  validateMigration(inventory, issues);
  if (issues.length)
    throw new Error(
      `release-tail contract check failed:\n- ${issues.join("\n- ")}`,
    );
  return {
    surfaces: surfaces.length,
    managedCallers: inventory.managedConsumerCallers.length,
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
      `release-tail contract check passed: ${report.surfaces} classified surfaces, ${report.coordinates} reverse-discovered coordinates, ${report.executionSites} execution sites, ${report.capabilities} declarative capabilities, ${report.managedCallers} managed callers`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { checkReleaseTailContract };
