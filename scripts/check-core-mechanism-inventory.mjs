#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED = [
  "owner",
  "writers",
  "schemas",
  "stores",
  "states",
  "events",
  "transitions",
  "recovery",
  "effects",
  "retry",
  "invalidation",
  "providerReadback",
  "publicSurfaces",
  "compatibilityCallers",
  "sourcePaths",
  "testPaths",
  "migrationDisposition",
  "unresolved",
];

function loadJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function registrySurfaceIds(root) {
  const cli = loadJson(root, "dist/site/cli-registry.json").commands.map(
    (entry) => `cli:${entry.id}`,
  );
  const workflows = loadJson(root, "dist/site/workflow-registry.json");
  const workflowIds = workflows.workflows.map(
    (entry) => `workflow:${entry.id}`,
  );
  const actionIds = workflows.actions.map((entry) => `action:${entry.id}`);
  const exports = Object.keys(loadJson(root, "package.json").exports).map(
    (entry) => `export:${entry}`,
  );
  return new Set([...cli, ...workflowIds, ...actionIds, ...exports]);
}

function listFiles(root, relativeRoot) {
  const start = path.join(root, relativeRoot);
  if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) return [];
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        visit(path.join(directory, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  visit(start);
  return files;
}

function validateRequiredDimensions(mechanism, issues) {
  for (const field of REQUIRED) {
    const value = mechanism[field];
    const empty = ["owner", "migrationDisposition"].includes(field)
      ? !String(value || "").trim()
      : !Array.isArray(value) || value.length === 0;
    if (empty) issues.push(`${mechanism.id}: ${field} is empty`);
  }
}

function validateCoordinates(root, mechanism, issues) {
  const writers = (mechanism.writers || []).filter((entry) =>
    /^(?:actions|bin|packages|scripts)\//u.test(entry),
  );
  for (const file of [
    ...(mechanism.sourcePaths || []),
    ...(mechanism.testPaths || []),
    ...writers,
  ]) {
    if (!fs.existsSync(path.join(root, file)))
      issues.push(`${mechanism.id}: coordinate is missing: ${file}`);
  }
}

function validateOwnership(mechanism, ownedSources, issues) {
  for (const file of mechanism.sourcePaths || []) {
    const prior = ownedSources.get(file);
    if (prior)
      issues.push(
        `${file}: ambiguous mechanism ownership (${prior}, ${mechanism.id})`,
      );
    ownedSources.set(file, mechanism.id);
  }
}

function validateSurfaces(mechanism, surfaces, issues) {
  for (const surface of mechanism.publicSurfaces || []) {
    if (!surfaces.has(surface))
      issues.push(
        `${mechanism.id}: public surface is absent from generated/package registries: ${surface}`,
      );
  }
}

function validateGitRefStore(root, mechanism, issues) {
  const source = (mechanism.sourcePaths || [])
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");
  const writesReleaseState = /refs\/heads\/buildchain\/release-state/u.test(
    source,
  );
  const declaresGitRef = (mechanism.stores || []).some((entry) =>
    /Git ref|refs\//u.test(entry),
  );
  if (writesReleaseState && !declaresGitRef)
    issues.push(
      `${mechanism.id}: Git-ref writer lacks an explicit store disposition`,
    );
}

function validateReverseScanReferences(root, reverseScan, issues) {
  const references = [
    ...(reverseScan.registries || []),
    ...(reverseScan.generatedReferences || []),
    reverseScan.commandRegistry,
    String(reverseScan.packageExports || "").split("#")[0],
  ].filter(Boolean);
  for (const file of references) {
    if (!fs.existsSync(path.join(root, file)))
      issues.push(`reverse scan reference is missing: ${file}`);
  }
}

function validateSurfaceKinds(inventory, issues) {
  const surfaceKinds = new Set(
    (inventory.mechanisms || []).flatMap((mechanism) =>
      (mechanism.publicSurfaces || []).map((surface) => surface.split(":")[0]),
    ),
  );
  for (const kind of ["action", "cli", "export", "workflow"]) {
    if (!surfaceKinds.has(kind))
      issues.push(`reverse scan has no ${kind} public surface coverage`);
  }
  return surfaceKinds;
}

function discoverAuthoritySources(root, reverseScan, ids, issues) {
  const discovered = new Map();
  for (const [index, rule] of (
    reverseScan.authoritySourceRules || []
  ).entries()) {
    if (!ids.has(rule?.mechanismId)) {
      issues.push(
        `authority source rule ${index} names an unknown mechanism: ${rule?.mechanismId || "<empty>"}`,
      );
      continue;
    }
    if (!rule.root || !rule.pattern) {
      issues.push(`authority source rule ${index} is incomplete`);
      continue;
    }
    let pattern;
    try {
      pattern = new RegExp(rule.pattern, "u");
    } catch (error) {
      issues.push(
        `authority source rule ${index} has an invalid pattern: ${error.message}`,
      );
      continue;
    }
    const matches = listFiles(root, rule.root).filter((file) =>
      pattern.test(file),
    );
    if (matches.length === 0)
      issues.push(
        `${rule.mechanismId}: authority source rule matched no files under ${rule.root}`,
      );
    for (const relative of matches) {
      const file = path.posix.join(rule.root, relative);
      const mechanismIds = discovered.get(file) || new Set();
      mechanismIds.add(rule.mechanismId);
      discovered.set(file, mechanismIds);
    }
  }
  return discovered;
}

function validateAuthorityOwnership(discovered, ownedSources, issues) {
  for (const [file, mechanismIds] of discovered) {
    if (mechanismIds.size !== 1) {
      issues.push(
        `${file}: ambiguous reverse-scan ownership (${[...mechanismIds].join(", ")})`,
      );
      continue;
    }
    const expected = [...mechanismIds][0];
    const owner = ownedSources.get(file);
    if (!owner)
      issues.push(`${file}: orphan authority coordinate for ${expected}`);
    else if (owner !== expected)
      issues.push(
        `${file}: authority coordinate is owned by ${owner}, expected ${expected}`,
      );
  }
}

function validateGitRefStoreScan(
  root,
  inventory,
  reverseScan,
  ownedSources,
  issues,
) {
  let gitRefStores = 0;
  for (const [index, store] of (reverseScan.gitRefStores || []).entries()) {
    const mechanism = (inventory.mechanisms || []).find(
      (entry) => entry.id === store?.mechanismId,
    );
    if (!mechanism || !store.sourcePath || !store.marker) {
      issues.push(`Git-ref store scan ${index} is incomplete`);
      continue;
    }
    const file = path.join(root, store.sourcePath);
    if (!fs.existsSync(file)) {
      issues.push(
        `${store.mechanismId}: Git-ref store source is missing: ${store.sourcePath}`,
      );
      continue;
    }
    if (ownedSources.get(store.sourcePath) !== store.mechanismId)
      issues.push(
        `${store.sourcePath}: Git-ref store source is not owned by ${store.mechanismId}`,
      );
    if (!fs.readFileSync(file, "utf8").includes(store.marker))
      issues.push(
        `${store.sourcePath}: Git-ref store marker is missing: ${store.marker}`,
      );
    if (
      !(mechanism.stores || []).some((entry) =>
        /Git ref|refs\/|ledger-ref|state ref/iu.test(entry),
      )
    )
      issues.push(
        `${store.mechanismId}: Git-ref store lacks an explicit disposition`,
      );
    gitRefStores += 1;
  }
  return gitRefStores;
}

function validateReverseScan(root, inventory, ids, ownedSources, issues) {
  const reverseScan = inventory.reverseScan || {};
  validateReverseScanReferences(root, reverseScan, issues);
  const surfaceKinds = validateSurfaceKinds(inventory, issues);
  const discovered = discoverAuthoritySources(root, reverseScan, ids, issues);
  validateAuthorityOwnership(discovered, ownedSources, issues);
  const gitRefStores = validateGitRefStoreScan(
    root,
    inventory,
    reverseScan,
    ownedSources,
    issues,
  );
  return {
    authorityCoordinates: discovered.size,
    gitRefStores,
    surfaceKinds: [...surfaceKinds].sort(),
  };
}

function checkCoreMechanismInventory({
  root = process.cwd(),
  inventory = loadJson(root, "architecture/v3-core-mechanism-inventory.json"),
} = {}) {
  const issues = [];
  if (
    inventory.schemaVersion !== 1 ||
    inventory.contract !== "kungfu-buildchain-v3-core-mechanism-inventory"
  )
    issues.push("inventory contract or schemaVersion is invalid");
  if (
    !/^[0-9a-f]{40}$/u.test(inventory.baseline?.commit || "") ||
    !/^[0-9a-f]{40}$/u.test(inventory.baseline?.tree || "")
  )
    issues.push("baseline must bind an exact commit and tree");
  if (inventory.maintainability?.dependencyCycles !== 0)
    issues.push("baseline must report the exact zero-cycle result");
  const surfaces = registrySurfaceIds(root);
  const ids = new Set();
  const ownedSources = new Map();
  for (const mechanism of inventory.mechanisms || []) {
    if (!mechanism.id || ids.has(mechanism.id))
      issues.push(
        `mechanism id is missing or duplicated: ${mechanism.id || "<empty>"}`,
      );
    ids.add(mechanism.id);
    validateRequiredDimensions(mechanism, issues);
    validateCoordinates(root, mechanism, issues);
    validateOwnership(mechanism, ownedSources, issues);
    validateSurfaces(mechanism, surfaces, issues);
    validateGitRefStore(root, mechanism, issues);
  }
  const reverseScan = validateReverseScan(
    root,
    inventory,
    ids,
    ownedSources,
    issues,
  );
  if ((inventory.mechanisms || []).length < 10)
    issues.push("inventory must retain all ten v3 core mechanism families");
  if (issues.length)
    throw new Error(
      `v3 core mechanism inventory check failed:\n- ${issues.join("\n- ")}`,
    );
  return {
    mechanisms: inventory.mechanisms.length,
    sourceCoordinates: ownedSources.size,
    publicSurfaces: inventory.mechanisms.reduce(
      (sum, entry) => sum + entry.publicSurfaces.length,
      0,
    ),
    dependencyCycles: inventory.maintainability.dependencyCycles,
    ...reverseScan,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const report = checkCoreMechanismInventory();
    console.log(
      `v3 core mechanism inventory check passed: ${report.mechanisms} mechanisms, ${report.sourceCoordinates} owned source coordinates, ${report.authorityCoordinates} reverse-discovered authority coordinates, ${report.publicSurfaces} public surfaces across ${report.surfaceKinds.length} registry kinds, ${report.gitRefStores} Git-ref stores, ${report.dependencyCycles} dependency cycles`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { checkCoreMechanismInventory };
