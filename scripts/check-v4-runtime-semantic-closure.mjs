#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const V4_RUNTIME_SEMANTIC_CLOSURE_CONTRACT =
  "kungfu-buildchain-v4-runtime-semantic-closure";
export const V4_RUNTIME_SEMANTIC_CLOSURE_PATH =
  "architecture/v4-runtime-semantic-closure.json";
export const REQUIRED_RUNTIME_EVIDENCE = Object.freeze([
  "positive",
  "negative",
  "failure",
  "recovery",
  "idempotence",
]);

function loadJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameMembers(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function publicSurfaceIds(root) {
  const packageJson = loadJson(root, "package.json");
  const cli = loadJson(root, "dist/site/cli-registry.json");
  const workflows = loadJson(root, "dist/site/workflow-registry.json");
  return new Set([
    ...Object.keys(packageJson.exports || {}).map((id) => `export:${id}`),
    ...(cli.commands || []).map((entry) => `cli:${entry.id}`),
    ...(workflows.workflows || []).map((entry) => `workflow:${entry.id}`),
    ...(workflows.actions || []).map((entry) => `action:${entry.id}`),
  ]);
}

function validateEvidence(root, mechanism, capability, issues) {
  const sourceTests = new Set(mechanism.testPaths || []);
  for (const dimension of REQUIRED_RUNTIME_EVIDENCE) {
    const entries = capability.evidence?.[dimension];
    if (!Array.isArray(entries) || entries.length === 0) {
      issues.push(`${capability.id}: ${dimension} evidence is empty`);
      continue;
    }
    for (const entry of entries) {
      if (!entry?.path || !entry?.name) {
        issues.push(`${capability.id}: ${dimension} evidence is incomplete`);
        continue;
      }
      if (!sourceTests.has(entry.path))
        issues.push(
          `${capability.id}: ${dimension} evidence is outside the reverse-scanned test set: ${entry.path}`,
        );
      const absolute = path.join(root, entry.path);
      if (!fs.existsSync(absolute)) {
        issues.push(
          `${capability.id}: evidence path is missing: ${entry.path}`,
        );
        continue;
      }
      const source = fs.readFileSync(absolute, "utf8");
      if (!source.includes(`test(${JSON.stringify(entry.name)}`))
        issues.push(
          `${capability.id}: evidence test is missing from ${entry.path}: ${entry.name}`,
        );
    }
  }
}

function validateResidualClosure(mechanism, capability, issues) {
  const sourceResiduals = mechanism.unresolved || [];
  const closed = capability.resolvedResiduals || [];
  if (
    !sameMembers(
      sourceResiduals,
      closed.map((entry) => entry?.source || ""),
    )
  )
    issues.push(
      `${capability.id}: resolved residual identities do not match the reverse scan`,
    );
  for (const entry of closed) {
    if (!String(entry?.resolution || "").trim())
      issues.push(`${capability.id}: residual resolution is empty`);
  }
}

function validateImplementation(root, mechanism, capability, issues) {
  if (
    !Array.isArray(capability.implementation) ||
    capability.implementation.length === 0
  ) {
    issues.push(`${capability.id}: implementation route is empty`);
    return;
  }
  const reverseScanned = new Set(mechanism.sourcePaths || []);
  let boundToReverseScan = false;
  for (const relativePath of capability.implementation) {
    if (!fs.existsSync(path.join(root, relativePath)))
      issues.push(
        `${capability.id}: implementation path is missing: ${relativePath}`,
      );
    if (reverseScanned.has(relativePath)) boundToReverseScan = true;
  }
  if (!boundToReverseScan)
    issues.push(
      `${capability.id}: implementation is not bound to a reverse-scanned v3 mechanism route`,
    );
}

function validateAuthority(capability, stateMachine, issues) {
  for (const field of [
    "exactHeadFence",
    "immutableRootFence",
    "providerReadbackBeforeRetry",
    "idempotentReplay",
  ]) {
    if (capability.invariants?.[field] !== true)
      issues.push(`${capability.id}: ${field} must remain true`);
  }
  if (capability.routeKind !== "v4-native")
    issues.push(`${capability.id}: routeKind must be v4-native`);
  if (capability.legacyFallbackAllowed !== false)
    issues.push(`${capability.id}: legacy fallback must remain disabled`);
  if (capability.providerDecisionAuthorityAllowed !== false)
    issues.push(
      `${capability.id}: provider decision authority must remain disabled`,
    );
  if (stateMachine) {
    if (capability.stateAuthority !== "single-writer-state-machine")
      issues.push(
        `${capability.id}: state-machine authority classification drifted`,
      );
    if (
      stateMachine.writer?.authoritative !== true ||
      stateMachine.writer?.secondWriterBudget !== 0
    )
      issues.push(`${capability.id}: v4 state machine is not single-writer`);
    if (
      !Array.isArray(stateMachine.recovery) ||
      stateMachine.recovery.length === 0
    )
      issues.push(`${capability.id}: v4 state machine recovery is empty`);
  } else if (capability.stateAuthority !== "bounded-protocol") {
    issues.push(
      `${capability.id}: bounded protocol authority classification drifted`,
    );
  }
}

export function validateRuntimeSemanticClosure({
  root = process.cwd(),
  manifest = loadJson(root, V4_RUNTIME_SEMANTIC_CLOSURE_PATH),
  v3Inventory = loadJson(root, "architecture/v3-core-mechanism-inventory.json"),
  v4Manifest = loadJson(
    root,
    "architecture/v4-capability-state-machine-manifest.json",
  ),
} = {}) {
  const issues = [];
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.contract !== V4_RUNTIME_SEMANTIC_CLOSURE_CONTRACT
  )
    issues.push(
      "runtime semantic closure contract or schemaVersion is invalid",
    );
  if (!sameMembers(manifest?.requiredEvidence || [], REQUIRED_RUNTIME_EVIDENCE))
    issues.push("runtime semantic closure evidence dimensions drifted");

  const mechanisms = new Map(
    (v3Inventory.mechanisms || []).map((entry) => [entry.id, entry]),
  );
  const v4Capabilities = new Map(
    (v4Manifest.capabilities || []).map((entry) => [entry.id, entry]),
  );
  const stateMachines = new Map(
    (v4Manifest.stateMachines || []).map((entry) => [entry.id, entry]),
  );
  const capabilities = Array.isArray(manifest?.capabilities)
    ? manifest.capabilities
    : [];
  if (
    !sameMembers(
      capabilities.map((entry) => entry.id),
      mechanisms.keys(),
    )
  )
    issues.push(
      "runtime semantic closure does not cover every v3 mechanism exactly once",
    );
  if (
    !sameMembers(
      capabilities.map((entry) => entry.id),
      v4Capabilities.keys(),
    )
  )
    issues.push(
      "runtime semantic closure does not match the v4 capability manifest",
    );

  const surfaces = publicSurfaceIds(root);
  const ids = new Set();
  for (const capability of capabilities) {
    if (!capability?.id || ids.has(capability.id)) {
      issues.push(
        `runtime semantic capability id is missing or duplicated: ${capability?.id || "<empty>"}`,
      );
      continue;
    }
    ids.add(capability.id);
    const mechanism = mechanisms.get(capability.id);
    const v4Capability = v4Capabilities.get(capability.id);
    if (!mechanism || !v4Capability) continue;
    if (capability.sourceMechanismId !== capability.id)
      issues.push(`${capability.id}: source mechanism identity drifted`);
    validateImplementation(root, mechanism, capability, issues);
    validateResidualClosure(mechanism, capability, issues);
    validateEvidence(root, mechanism, capability, issues);
    validateAuthority(capability, stateMachines.get(capability.id), issues);
    for (const surface of v4Capability.surfaces || []) {
      if (!surfaces.has(surface))
        issues.push(
          `${capability.id}: executable v4 surface is absent: ${surface}`,
        );
    }
  }

  if (issues.length)
    throw new Error(
      `v4 runtime semantic closure failed:\n- ${issues.join("\n- ")}`,
    );
  return {
    capabilities: capabilities.length,
    evidenceDimensions: capabilities.length * REQUIRED_RUNTIME_EVIDENCE.length,
    residualsClosed: capabilities.reduce(
      (sum, entry) => sum + entry.resolvedResiduals.length,
      0,
    ),
    legacyFallbacks: 0,
    providerDecisionAuthorities: 0,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const report = validateRuntimeSemanticClosure();
    console.log(
      `v4 runtime semantic closure passed: ${report.capabilities} capabilities, ` +
        `${report.evidenceDimensions} evidence dimensions, ${report.residualsClosed} reverse-scan residuals closed, ` +
        "0 legacy fallbacks, 0 provider decision authorities",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
