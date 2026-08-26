#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  collectHistoryRows,
  collectRevisionCatalog,
  countsBy,
  git,
  sha256,
} from "./v3-v4-capability-catalog.mjs";

export const V3_V4_CAPABILITY_INVENTORY_CONTRACT =
  "kungfu-buildchain-v3-v4-live-capability-inventory";
export const V3_V4_CAPABILITY_CUTS = Object.freeze({
  priorFamilyV3: "6b96bdad8d9f8ccf9275f27d9370a226a9c78465",
  liveV3: "88d089b9c69dd08be00f120d623447ae881f1374",
  liveV4: "08af14ed7dcfaa260401b517d1dd4b0c094b3add",
});

const INVENTORY_PATH = "architecture/v3-v4-live-capability-inventory.json";
const ALLOWED_DISPOSITIONS = new Set([
  "v4-native",
  "compatibility-adapter",
  "executable-migration",
  "owned-missing",
]);
const ASSIGNMENTS = Object.freeze({
  public: "2026-08-26-buildchain-v4-public-surface-compatibility-closure",
  runtime: "2026-08-26-buildchain-v4-runtime-semantic-closure",
  adopter: "2026-08-26-buildchain-v4-cross-platform-adopter-qualification",
  stable: "2026-08-26-buildchain-v4-stable-channel-capability-closure",
  retirement: "2026-08-26-buildchain-v4-v3-retirement-reconciliation",
});
const REQUIRED_CATEGORIES = Object.freeze([
  "action",
  "action-input",
  "cli-command",
  "cli-option",
  "config-contract",
  "documented-module",
  "generated-contract",
  "history-change",
  "node-export",
  "node-symbol",
  "observable-evidence-contract",
  "platform-branch",
  "release-delivery-recovery",
  "source-schema",
  "workflow",
  "workflow-input",
  "workflow-output",
  "workflow-secret",
]);
const MIGRATION_ROUTES = new Map([
  [
    "source-schema:contracts/publication-rehearsal-capsule-v1.schema.json",
    "source-schema:contracts/v4-publication-rehearsal-capsule-v1.schema.json",
  ],
  [
    "generated-contract:dist/site/schemas/publication-rehearsal-capsule-v1.schema.json",
    "generated-contract:dist/site/schemas/v4-publication-rehearsal-capsule-v1.schema.json",
  ],
  [
    "generated-contract:dist/site/schemas/release-tail-provider-bindings-v1.schema.json",
    "source-schema:contracts/release-tail-provider-bindings-v1.schema.json",
  ],
]);
const HISTORY_MIGRATION_PATHS = new Map([
  [
    "actions/promote-buildchain-ref/internal/alpha-publication-recovery.js",
    "actions/promote-buildchain-ref/internal/promote-alpha-channel.js",
  ],
  ["scripts/release-candidate-tail-reseal.mjs", "scripts/v4-tail-reseal.mjs"],
  [
    "tests/release-candidate-tail-reseal.test.mjs",
    "tests/v4-tail-reseal-parity.test.mjs",
  ],
]);

function capabilityCutAvailable(root, revision) {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function ensureCapabilityCutsAvailable(root) {
  const revisions = Object.values(V3_V4_CAPABILITY_CUTS);
  const missing = revisions.filter(
    (revision) => !capabilityCutAvailable(root, revision),
  );
  if (missing.length) {
    execFileSync(
      "git",
      ["fetch", "--no-tags", "--depth=128", "origin", ...missing],
      { cwd: root, stdio: "ignore" },
    );
  }
  const unavailable = revisions.filter(
    (revision) => !capabilityCutAvailable(root, revision),
  );
  if (unavailable.length) {
    throw new Error(
      `v3/v4 capability cuts are unavailable after a bounded origin fetch: ${unavailable.join(", ")}`,
    );
  }
}
const RUNTIME_SYMBOLS = Object.freeze([
  "createPublicationRehearsalCapsule",
  "executePublicationRehearsal",
  "normalizePublicationRehearsalCapsule",
  "PUBLICATION_REHEARSAL_CAPSULE_CONTRACT",
  "PUBLICATION_REHEARSAL_COMMAND",
  "PUBLICATION_REHEARSAL_DIAGNOSTIC_CONTRACT",
  "PUBLICATION_REHEARSAL_EVIDENCE_CONTRACT",
  "publicationRehearsalBindingRoot",
  "publicationRehearsalDiagnostic",
  "PublicationRehearsalError",
  "RELEASE_LOCAL_CONSTRUCTIBILITY_ADR",
  "RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT",
  "resolvePublicationRehearsalFile",
  "verifyPublicationRehearsalCapsule",
]);
const PROJECTION_SYMBOLS = Object.freeze([
  "appendPublicationRehearsalToml",
  "assertPublicationRehearsalConfig",
  "mergePublicationRehearsalAgentInstructions",
  "projectPublicationRehearsalToml",
  "PUBLICATION_REHEARSAL_AGENT_SECTION_END",
  "PUBLICATION_REHEARSAL_AGENT_SECTION_START",
  "PUBLICATION_REHEARSAL_WORKFLOW_PATH",
  "publicationRehearsalAgentInstructions",
  "publicationRehearsalToml",
  "publicationRehearsalWorkflow",
]);
const EXPECTED_RESIDUAL_IDS = new Set([
  "documented-module:./publication-rehearsal-projection",
  "documented-module:./publication-rehearsal-runtime",
  "node-export:./publication-rehearsal-projection",
  "node-export:./publication-rehearsal-runtime",
  "node-symbol:./release-passport#releasePassportKfdAdopterSourceSha",
  ...RUNTIME_SYMBOLS.map(
    (name) => `node-symbol:./publication-rehearsal-runtime#${name}`,
  ),
  ...PROJECTION_SYMBOLS.map(
    (name) => `node-symbol:./publication-rehearsal-projection#${name}`,
  ),
  "cli-option:collect-github-release#--adopter-delivery-json",
  "cli-option:release-tail#--capsule-root",
  "cli-option:release-tail#--environment-json",
  "workflow-input:.build#buildchain-contract-expected-channel",
  "workflow-input:.build#buildchain-contract-expected-major",
  "workflow-input:.release-candidate-promote#release-passport-adopter-delivery-json",
  "workflow-input:.release-candidate-promote#release-passport-kfd-adopter-manifest-gate-json",
  "workflow-input:.web-surface#buildchain-contract-expected-channel",
  "workflow-input:.web-surface#buildchain-contract-expected-major",
  "workflow-input:dev-pr-auto-merge#defer-landing",
  "workflow-input:release-candidate-promote#release-passport-adopter-delivery-json",
  "workflow-input:release-candidate-promote#release-passport-kfd-adopter-manifest-gate-json",
  "workflow-input:release-tail#capsule-contract",
  "workflow-input:release-tail#capsule-path",
  "workflow-input:release-tail#capsule-root",
  "workflow-input:release-tail#evidence-path",
  "workflow-output:release-tail#binding-root",
  "workflow-output:release-tail#evidence-root",
  "action-input:promote-buildchain-ref#plan-before-target-advance",
  "action-input:promote-buildchain-ref#release-passport-adopter-delivery-json",
  "action-input:promote-buildchain-ref#release-passport-kfd-adopter-manifest-gate-json",
  "action-input:release-tail#capsule",
  "action-input:release-tail#capsule-contract",
  "action-input:release-tail#capsule-root",
  "action-input:release-tail#evidence-path",
]);

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJson(entry)]),
  );
}

export function canonicalInventoryJson(value) {
  return `${JSON.stringify(stableJson(value), null, 2)}\n`;
}

function ownerForCategory(category, identity) {
  const publicCategories = new Set([
    "action",
    "action-input",
    "cli-command",
    "cli-option",
    "documented-module",
    "node-export",
    "node-symbol",
    "workflow",
    "workflow-input",
    "workflow-output",
    "workflow-secret",
  ]);
  if (publicCategories.has(category)) return ASSIGNMENTS.public;
  if (category === "platform-branch") return ASSIGNMENTS.adopter;
  if (["generated-contract", "observable-evidence-contract"].includes(category))
    return ASSIGNMENTS.stable;
  if (category === "history-change") return ASSIGNMENTS.retirement;
  if (category === "release-delivery-recovery") return ASSIGNMENTS.runtime;
  if (
    category === "source-schema" &&
    /release|publication|passport/u.test(identity)
  )
    return ASSIGNMENTS.stable;
  return ASSIGNMENTS.runtime;
}

function rowFromCatalogEntry(source, targetCatalog) {
  const ownerAssignment = ownerForCategory(source.category, source.identity);
  const direct = targetCatalog.get(source.id);
  const migratedId = MIGRATION_ROUTES.get(source.id);
  const migrated = migratedId ? targetCatalog.get(migratedId) : undefined;
  let disposition;
  let v4Route = null;
  let residual = null;
  if (direct) {
    disposition =
      source.category === "release-delivery-recovery"
        ? "compatibility-adapter"
        : "v4-native";
    v4Route = { capabilityId: direct.id, evidence: direct.evidence };
  } else if (migrated) {
    disposition = "executable-migration";
    v4Route = { capabilityId: migrated.id, evidence: migrated.evidence };
  } else if (EXPECTED_RESIDUAL_IDS.has(source.id)) {
    disposition = "owned-missing";
    residual = {
      ownerAssignment,
      requiredOutcome:
        "add an executable v4 compatibility route or an explicit source-bound migration",
    };
  } else {
    throw new Error(`unclassified live v3 capability: ${source.id}`);
  }
  return {
    id: source.id,
    category: source.category,
    disposition,
    ownerAssignment,
    sourceEvidence: source.evidence,
    v4Route,
    residual,
    positiveProbe:
      disposition === "owned-missing"
        ? "residual identity and owner match the closed expected-residual set"
        : "the exact v4 cut contains the declared route evidence",
    negativeProbe:
      disposition === "owned-missing"
        ? "removing the owner or changing the residual identity fails validation"
        : "removing or substituting the declared v4 route fails validation",
  };
}

function sourceCut(root, commit, role) {
  return {
    branch: "origin/dev/v3/v3.0",
    commit,
    tree: git(root, ["rev-parse", `${commit}^{tree}`]),
    role,
  };
}

export function buildV3V4CapabilityInventory({ root = process.cwd() } = {}) {
  ensureCapabilityCutsAvailable(root);
  git(root, [
    "merge-base",
    "--is-ancestor",
    V3_V4_CAPABILITY_CUTS.priorFamilyV3,
    V3_V4_CAPABILITY_CUTS.liveV3,
  ]);
  const v3 = collectRevisionCatalog({
    root,
    revision: V3_V4_CAPABILITY_CUTS.liveV3,
    liveV3Revision: V3_V4_CAPABILITY_CUTS.liveV3,
  });
  const v4 = collectRevisionCatalog({
    root,
    revision: V3_V4_CAPABILITY_CUTS.liveV4,
    liveV3Revision: V3_V4_CAPABILITY_CUTS.liveV3,
  });
  const rows = [
    ...[...v3.catalog.values()].map((entry) =>
      rowFromCatalogEntry(entry, v4.catalog),
    ),
    ...collectHistoryRows({
      root,
      priorRevision: V3_V4_CAPABILITY_CUTS.priorFamilyV3,
      liveV3Revision: V3_V4_CAPABILITY_CUTS.liveV3,
      v4Paths: v4.paths,
      migrationPaths: HISTORY_MIGRATION_PATHS,
      ownerAssignment: ASSIGNMENTS.retirement,
    }),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const changedPaths = rows.filter((row) => row.category === "history-change");
  const prior = sourceCut(
    root,
    V3_V4_CAPABILITY_CUTS.priorFamilyV3,
    "previous-absorption-family-capture",
  );
  const liveV3 = sourceCut(
    root,
    V3_V4_CAPABILITY_CUTS.liveV3,
    "execution-time-protected-read-only-reference",
  );
  const liveV4 = sourceCut(
    root,
    V3_V4_CAPABILITY_CUTS.liveV4,
    "execution-time-protected-target",
  );
  liveV4.branch = "origin/dev/v4/v4.0";
  const inventory = {
    schemaVersion: 1,
    contract: V3_V4_CAPABILITY_INVENTORY_CONTRACT,
    sourceCuts: { priorFamilyV3: prior, liveV3, liveV4 },
    extraction: {
      mode: "exact-git-object-closed-world",
      extractor: "scripts/check-v3-v4-capability-inventory.mjs",
      categories: REQUIRED_CATEGORIES,
      sources: [
        "package.json#exports",
        "dist/site/node-api-registry.json",
        "dist/site/cli-registry.json",
        "dist/site/workflow-registry.json",
        "contracts/**/*.schema.json",
        ".buildchain/*.{json,toml}",
        "dist/site/schemas/*.schema.json",
        "architecture/v3-core-mechanism-inventory.json",
        "architecture/v4-capability-state-machine-manifest.json",
        ".github/workflows/*.{yml,yaml}",
        "git diff <prior-family-v3>..<live-v3>",
      ],
      unknownPolicy: "fail-closed",
      residualPolicy: "exact-identity-allowlist-with-required-owner",
    },
    reverseHistory: {
      fromCommit: V3_V4_CAPABILITY_CUTS.priorFamilyV3,
      toCommit: V3_V4_CAPABILITY_CUTS.liveV3,
      commitCount: Number(
        git(root, [
          "rev-list",
          "--count",
          `${V3_V4_CAPABILITY_CUTS.priorFamilyV3}..${V3_V4_CAPABILITY_CUTS.liveV3}`,
        ]),
      ),
      changedPathCount: changedPaths.length,
      changedPathSetRoot: sha256(
        changedPaths.map((row) => row.sourceEvidence.path).join("\n"),
      ),
      unclassifiedPathCount: 0,
    },
    summary: {
      capabilityCount: rows.length,
      categoryCounts: countsBy(rows, "category"),
      dispositionCounts: countsBy(rows, "disposition"),
      residualCount: rows.filter((row) => row.disposition === "owned-missing")
        .length,
      unknownCount: 0,
      unownedCount: 0,
    },
    capabilities: rows,
  };
  assertV3V4CapabilityInventory(inventory);
  return inventory;
}

function validateRoute(row, issues) {
  if (row.disposition === "owned-missing") {
    if (!EXPECTED_RESIDUAL_IDS.has(row.id))
      issues.push(`${row.id}: residual is not in the exact expected set`);
    if (!row?.residual?.ownerAssignment || row.v4Route)
      issues.push(`${row.id}: owned residual binding is invalid`);
    return;
  }
  if (
    !row?.v4Route?.capabilityId ||
    !row?.v4Route?.evidence?.path ||
    row.residual
  ) {
    issues.push(
      `${row.id}: executable v4 route is missing or conflicts with a residual`,
    );
    return;
  }
  const historyPath =
    row.category === "history-change" ? row.sourceEvidence?.path : "";
  const expectedRouteId = historyPath
    ? `path:${HISTORY_MIGRATION_PATHS.get(historyPath) || historyPath}`
    : MIGRATION_ROUTES.get(row.id) || row.id;
  if (row.v4Route.capabilityId !== expectedRouteId)
    issues.push(
      `${row.id}: v4 route identity does not match the exact direct or migration policy`,
    );
}

function validateRow(row, ids, issues) {
  if (!row?.id || ids.has(row.id))
    issues.push(
      `capability id is missing or duplicated: ${row?.id || "<empty>"}`,
    );
  ids.add(row?.id);
  if (!REQUIRED_CATEGORIES.includes(row?.category))
    issues.push(`${row?.id}: category is unknown`);
  if (!ALLOWED_DISPOSITIONS.has(row?.disposition))
    issues.push(`${row?.id}: disposition is unknown`);
  if (!Object.values(ASSIGNMENTS).includes(row?.ownerAssignment))
    issues.push(`${row?.id}: owner Assignment is missing or unknown`);
  if (!row?.sourceEvidence?.path || !row?.sourceEvidence?.selector)
    issues.push(`${row?.id}: source evidence is incomplete`);
  if (!row?.positiveProbe || !row?.negativeProbe)
    issues.push(`${row?.id}: positive and negative probes are required`);
  validateRoute(row, issues);
}

function validateCoverage(inventory, rows, issues) {
  for (const category of REQUIRED_CATEGORIES) {
    if (!rows.some((row) => row.category === category))
      issues.push(`required category has zero coverage: ${category}`);
  }
  const actualResiduals = new Set(
    rows
      .filter((row) => row.disposition === "owned-missing")
      .map((row) => row.id),
  );
  for (const id of EXPECTED_RESIDUAL_IDS) {
    if (!actualResiduals.has(id))
      issues.push(`expected residual is absent: ${id}`);
  }
  if (
    inventory?.reverseHistory?.fromCommit !==
      V3_V4_CAPABILITY_CUTS.priorFamilyV3 ||
    inventory?.reverseHistory?.toCommit !== V3_V4_CAPABILITY_CUTS.liveV3 ||
    inventory?.reverseHistory?.unclassifiedPathCount !== 0
  ) {
    issues.push(
      "reverse history does not close the exact prior-family-to-live-v3 range",
    );
  }
  if (
    inventory?.summary?.unknownCount !== 0 ||
    inventory?.summary?.unownedCount !== 0
  ) {
    issues.push("inventory summary contains unknown or unowned capabilities");
  }
}

export function assertV3V4CapabilityInventory(inventory) {
  const issues = [];
  if (
    inventory?.schemaVersion !== 1 ||
    inventory?.contract !== V3_V4_CAPABILITY_INVENTORY_CONTRACT
  ) {
    issues.push("inventory contract or schemaVersion is invalid");
  }
  const rows = Array.isArray(inventory?.capabilities)
    ? inventory.capabilities
    : [];
  const ids = new Set();
  for (const row of rows) validateRow(row, ids, issues);
  validateCoverage(inventory, rows, issues);
  if (issues.length)
    throw new Error(
      `v3-to-v4 capability inventory failed:\n- ${issues.join("\n- ")}`,
    );
  return inventory;
}

function main() {
  const root = process.cwd();
  const inventory = buildV3V4CapabilityInventory({ root });
  const expected = canonicalInventoryJson(inventory);
  if (process.argv.includes("--write")) {
    fs.writeFileSync(path.join(root, INVENTORY_PATH), expected);
    console.log(
      `wrote ${INVENTORY_PATH}: ${inventory.summary.capabilityCount} capabilities`,
    );
    return;
  }
  const actual = fs.readFileSync(path.join(root, INVENTORY_PATH), "utf8");
  if (actual !== expected)
    throw new Error(
      `${INVENTORY_PATH} is stale; run node scripts/check-v3-v4-capability-inventory.mjs --write`,
    );
  console.log(
    `v3-to-v4 capability inventory passed: ${inventory.summary.capabilityCount} capabilities, ` +
      `${inventory.reverseHistory.changedPathCount} reverse-history paths, ` +
      `${inventory.summary.residualCount} owned residuals, 0 unknown, 0 unowned`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
