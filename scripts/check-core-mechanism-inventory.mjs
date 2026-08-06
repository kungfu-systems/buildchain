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
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const report = checkCoreMechanismInventory();
    console.log(
      `v3 core mechanism inventory check passed: ${report.mechanisms} mechanisms, ${report.sourceCoordinates} source coordinates, ${report.publicSurfaces} public surfaces, ${report.dependencyCycles} dependency cycles`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { checkCoreMechanismInventory };
