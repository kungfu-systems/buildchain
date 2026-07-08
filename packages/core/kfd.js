import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  createBuildchainKfd1Witness,
  createBuildchainKfd2Claims,
  createBuildchainKfd3ArtifactWitness,
  createBuildchainKfd3PrebuildWitness,
  createBuildchainKfdClaimRegistry,
  createBuildchainKfdSurfaceRegistry,
  createBuildchainPublicClaimDefinitions,
} from "./buildchain-kfd-claims.js";
import {
  migrateBuildchainLayout,
  planBuildchainLayoutMigration,
  resolveBuildchainConfigPath,
  resolveBuildchainContractLockPath,
  resolveKfd3SurfaceRegistryPath,
  resolveReleasePassportPath,
} from "./buildchain-layout.js";
import {
  createKfd1ReleaseGateEvidence,
  createKfd3CollaborationInterfaceReleaseGateEvidence,
  normalizeKfd1ContractWorldWitness,
  normalizeKfd3CollaborationInterfaceArtifactWitness,
  normalizeKfd3CollaborationInterfacePrebuildWitness,
  resolveKfd1Metadata,
  resolveKfd2Metadata,
  resolveKfd3Metadata,
  validateKfd1ReleaseGateEvidence,
  validateKfd2TrustTaxonomyEntry,
  validateKfd3CollaborationInterfaceReleaseGateEvidence,
} from "./kfd-gate.js";
import {
  auditKfd3Surfaces,
  createKfd3SurfaceWitness,
  detectKfd3Surfaces,
  queryKfd3Capabilities,
  readKfd3SurfaceRegistry,
  registerKfd3Surfaces,
  writeKfd3SurfaceRegistry,
} from "./kfd3-surface-register.js";

const require = createRequire(import.meta.url);

function readJsonPackageExport(exportPath) {
  return JSON.parse(fs.readFileSync(require.resolve(exportPath), "utf8"));
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonInput(value, { cwd = process.cwd(), label = "json" } = {}) {
  const input = String(value || "").trim();
  if (!input) {
    throw new Error(`${label} is required`);
  }
  const filePath = path.isAbsolute(input) ? input : path.join(cwd, input);
  if (fs.existsSync(filePath)) {
    return readJsonFile(filePath);
  }
  return JSON.parse(input);
}

function readJsonInputs(values = [], { cwd = process.cwd(), label = "json" } = {}) {
  return values.map((value, index) => readJsonInput(value, { cwd, label: `${label}[${index}]` }));
}

function issue(level, code, message, detail = {}) {
  return { level, code, message, ...detail };
}

function validateTaxonomyEntryToIssues(entry, { kind, label }) {
  try {
    validateKfd2TrustTaxonomyEntry(entry, { kind, label });
    return [];
  } catch (error) {
    return [issue("error", `${label}.taxonomy`, error.message)];
  }
}

export function normalizeKfdStandardId(value) {
  const raw = String(value || "").trim().toLowerCase();
  const match = raw.match(/^(?:kfd[-\s]?)?([1-9][0-9]*)$/);
  if (!match) {
    throw new Error(`unsupported KFD standard: ${value}`);
  }
  return `kfd-${match[1]}`;
}

export function discoverKfdStandards() {
  const packageJson = readJsonPackageExport("@kungfu-tech/kfd/package.json");
  const standards = readJsonPackageExport("@kungfu-tech/kfd/standards.json");
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-kfd-standard-discovery",
    package: {
      name: packageJson.name,
      version: packageJson.version,
      repository: packageJson.repository?.url || "",
    },
    metadataSchema: standards.metadataSchema || {},
    source: standards.source || {},
    standards: Object.entries(standards.standards || {})
      .map(([key, value]) => ({
        key: value?.key || key,
        id: value?.id || value?.label || key,
        label: value?.label || value?.id || key,
        title: value?.title || "",
        status: value?.status || "",
        revision: value?.revision || 0,
        schemaIds: { ...(value?.schemaIds || {}) },
        schemaPaths: { ...(value?.schemaPaths || {}) },
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function listKfdSchemas({ standard = "" } = {}) {
  const discovery = discoverKfdStandards();
  const selectedStandard = standard ? normalizeKfdStandardId(standard) : "";
  const schemas = [];
  for (const entry of discovery.standards) {
    if (selectedStandard && normalizeKfdStandardId(entry.key) !== selectedStandard) continue;
    const names = [...new Set([
      ...Object.keys(entry.schemaIds || {}),
      ...Object.keys(entry.schemaPaths || {}),
    ])].sort();
    for (const name of names) {
      schemas.push({
        standard: entry.key,
        name,
        schemaId: entry.schemaIds?.[name] || "",
        schemaPath: entry.schemaPaths?.[name] || "",
      });
    }
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-kfd-schema-list",
    package: discovery.package,
    standard: selectedStandard || "",
    schemas,
  };
}

export function readKfdSchema({ standard, schema = "" } = {}) {
  const selectedStandard = normalizeKfdStandardId(standard);
  const schemaList = listKfdSchemas({ standard: selectedStandard }).schemas;
  const selectedSchema = schema
    ? schemaList.find((entry) => entry.name === schema || entry.schemaId === schema || entry.schemaPath === schema)
    : schemaList[0];
  if (!selectedSchema?.schemaPath) {
    throw new Error(`KFD schema not found for ${selectedStandard}${schema ? `:${schema}` : ""}`);
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-kfd-schema",
    standard: selectedStandard,
    name: selectedSchema.name,
    schemaId: selectedSchema.schemaId,
    schemaPath: selectedSchema.schemaPath,
    schema: readJsonPackageExport(`@kungfu-tech/kfd/${selectedSchema.schemaPath}`),
  };
}

export const schemas = Object.freeze({
  discover: discoverKfdStandards,
  list: listKfdSchemas,
  read: readKfdSchema,
});

export const kfd1 = Object.freeze({
  resolveMetadata: resolveKfd1Metadata,
  normalizeContractWorldWitness: normalizeKfd1ContractWorldWitness,
  createReleaseGateEvidence: createKfd1ReleaseGateEvidence,
  validateReleaseGateEvidence: validateKfd1ReleaseGateEvidence,
  createBuildchainWitness: createBuildchainKfd1Witness,
  createGate: ({ cwd = process.cwd(), witnessJsons = [], artifactRoot = "", artifacts = [] } = {}) => createKfd1ReleaseGateEvidence({
    cwd,
    artifactRoot,
    artifacts,
    witnesses: readJsonInputs(witnessJsons, { cwd, label: "kfd-1 witness" }),
  }),
  validateGate: (section) => validateKfd1ReleaseGateEvidence(section),
});

export const kfd2 = Object.freeze({
  resolveMetadata: resolveKfd2Metadata,
  validateTrustTaxonomyEntry: validateKfd2TrustTaxonomyEntry,
  createBuildchainClaims: createBuildchainKfd2Claims,
  createBuildchainPublicClaimDefinitions,
  readFoundationTrustClaims: () => readJsonPackageExport("@kungfu-tech/kfd/buildchain/kfd-2/kfd-foundation.trust-claims.json"),
  readFoundationTrustAssessment: () => readJsonPackageExport("@kungfu-tech/kfd/buildchain/kfd-2/kfd-foundation.trust-assessment.json"),
  validateTaxonomyEntries: ({ entries = [], kind = "residualRisk" } = {}) => entries.map((entry, index) => validateKfd2TrustTaxonomyEntry(entry, {
    kind,
    label: `${kind}[${index}]`,
  })),
  validateTrustClaims: (document = {}) => {
    const issues = [];
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      issues.push(issue("error", "kfd-2.trustClaims.object", "KFD-2 trust claims must be a JSON object"));
    }
    if (document.contract !== "kfd-2-trust-claims") {
      issues.push(issue("error", "kfd-2.trustClaims.contract", "KFD-2 trust claims contract must be kfd-2-trust-claims"));
    }
    if (document.standard !== "kfd-2") {
      issues.push(issue("error", "kfd-2.trustClaims.standard", "KFD-2 trust claims standard must be kfd-2"));
    }
    const claims = Array.isArray(document.claims) ? document.claims : [];
    if (claims.length === 0) {
      issues.push(issue("error", "kfd-2.trustClaims.claims", "KFD-2 trust claims must include at least one claim"));
    }
    for (const [index, claim] of claims.entries()) {
      if (!claim?.id || !claim?.statement) {
        issues.push(issue("error", `kfd-2.trustClaims.claims[${index}]`, "KFD-2 trust claim must include id and statement"));
      }
      if (!Array.isArray(claim?.facts) || claim.facts.length === 0) {
        issues.push(issue("error", `kfd-2.trustClaims.claims[${index}].facts`, "KFD-2 trust claim must bind at least one fact"));
      }
      if (!Array.isArray(claim?.evidence) || claim.evidence.length === 0) {
        issues.push(issue("error", `kfd-2.trustClaims.claims[${index}].evidence`, "KFD-2 trust claim must bind at least one evidence entry"));
      }
      for (const [riskIndex, risk] of (claim?.residualRisk || []).entries()) {
        issues.push(...validateTaxonomyEntryToIssues(risk, {
          kind: "residualRisk",
          label: `kfd-2.trustClaims.claims[${index}].residualRisk[${riskIndex}]`,
        }));
      }
    }
    return {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-2-trust-claims-validation",
      ok: issues.filter((entry) => entry.level === "error").length === 0,
      claimCount: claims.length,
      issues,
    };
  },
  validateTrustAssessment: (document = {}) => {
    const issues = [];
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      issues.push(issue("error", "kfd-2.trustAssessment.object", "KFD-2 trust assessment must be a JSON object"));
    }
    if (document.contract !== "kfd-2-trust-assessment") {
      issues.push(issue("error", "kfd-2.trustAssessment.contract", "KFD-2 trust assessment contract must be kfd-2-trust-assessment"));
    }
    if (document.standard !== "kfd-2") {
      issues.push(issue("error", "kfd-2.trustAssessment.standard", "KFD-2 trust assessment standard must be kfd-2"));
    }
    if (!["pass", "fail", "warning", "unverifiable"].includes(document.result)) {
      issues.push(issue("error", "kfd-2.trustAssessment.result", "KFD-2 trust assessment result must be pass, fail, warning, or unverifiable"));
    }
    const assessments = Array.isArray(document.assessments) ? document.assessments : [];
    if (assessments.length === 0) {
      issues.push(issue("error", "kfd-2.trustAssessment.assessments", "KFD-2 trust assessment must include at least one assessment"));
    }
    for (const [index, assessment] of assessments.entries()) {
      if (!assessment?.id || !assessment?.claimId) {
        issues.push(issue("error", `kfd-2.trustAssessment.assessments[${index}]`, "KFD-2 trust assessment must include id and claimId"));
      }
      for (const [riskIndex, risk] of (assessment?.residualRisk || []).entries()) {
        issues.push(...validateTaxonomyEntryToIssues(risk, {
          kind: "residualRisk",
          label: `kfd-2.trustAssessment.assessments[${index}].residualRisk[${riskIndex}]`,
        }));
      }
    }
    for (const [reasonIndex, reason] of (document.downgradeReasons || []).entries()) {
      issues.push(...validateTaxonomyEntryToIssues(reason, {
        kind: "downgradeReason",
        label: `kfd-2.trustAssessment.downgradeReasons[${reasonIndex}]`,
      }));
    }
    return {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-2-trust-assessment-validation",
      ok: issues.filter((entry) => entry.level === "error").length === 0,
      result: document.result || "",
      assessmentCount: assessments.length,
      issues,
    };
  },
});

export const kfd3 = Object.freeze({
  resolveMetadata: resolveKfd3Metadata,
  normalizePrebuildWitness: normalizeKfd3CollaborationInterfacePrebuildWitness,
  normalizeArtifactWitness: normalizeKfd3CollaborationInterfaceArtifactWitness,
  createReleaseGateEvidence: createKfd3CollaborationInterfaceReleaseGateEvidence,
  validateReleaseGateEvidence: validateKfd3CollaborationInterfaceReleaseGateEvidence,
  detectSurfaces: detectKfd3Surfaces,
  registerSurfaces: registerKfd3Surfaces,
  auditSurfaces: auditKfd3Surfaces,
  createSurfaceWitness: createKfd3SurfaceWitness,
  queryCapabilities: queryKfd3Capabilities,
  readSurfaceRegistry: readKfd3SurfaceRegistry,
  writeSurfaceRegistry: writeKfd3SurfaceRegistry,
  createBuildchainPrebuildWitness: createBuildchainKfd3PrebuildWitness,
  createBuildchainArtifactWitness: createBuildchainKfd3ArtifactWitness,
  createBuildchainSurfaceRegistry: createBuildchainKfdSurfaceRegistry,
});

export const kfd4 = Object.freeze({
  schemas: {
    list: (options = {}) => listKfdSchemas({ ...options, standard: "kfd-4" }),
    read: (options = {}) => readKfdSchema({ ...options, standard: "kfd-4" }),
  },
  status: "schema-only",
});

export const buildchainKfdClaims = Object.freeze({
  createClaimRegistry: createBuildchainKfdClaimRegistry,
  createSurfaceRegistry: createBuildchainKfdSurfaceRegistry,
  createPublicClaimDefinitions: createBuildchainPublicClaimDefinitions,
});

export function collectKfdStatus({ cwd = process.cwd() } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const schemas = listKfdSchemas();
  const layout = planBuildchainLayoutMigration({ cwd: resolvedCwd });
  const paths = {
    config: resolveBuildchainConfigPath(resolvedCwd),
    contractLock: resolveBuildchainContractLockPath(resolvedCwd),
    kfd3SurfaceRegistry: resolveKfd3SurfaceRegistryPath(resolvedCwd),
    releasePassport: resolveReleasePassportPath(resolvedCwd),
  };
  const pathStatus = Object.fromEntries(Object.entries(paths).map(([key, relPath]) => [
    key,
    {
      path: relPath,
      exists: fs.existsSync(path.join(resolvedCwd, relPath)),
    },
  ]));
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-kfd-status",
    cwd: resolvedCwd,
    layout: {
      status: layout.status,
      canonicalRoot: layout.canonicalRoot,
      migrationNeeded: layout.moves.length > 0,
      moves: layout.moves,
    },
    standards: schemas.schemas.reduce((acc, entry) => {
      acc[entry.standard] ||= [];
      acc[entry.standard].push({
        name: entry.name,
        schemaId: entry.schemaId,
        schemaPath: entry.schemaPath,
      });
      return acc;
    }, {}),
    support: {
      "kfd-1": ["schema", "witness", "gate", "verify"],
      "kfd-2": ["schema", "taxonomy", "claims", "trust-claims", "trust-assessment"],
      "kfd-3": ["schema", "detect", "register", "audit", "witness", "query"],
      "kfd-4": ["schema"],
    },
    paths: pathStatus,
  };
}

export const layout = Object.freeze({
  plan: planBuildchainLayoutMigration,
  migrate: migrateBuildchainLayout,
  resolveConfigPath: resolveBuildchainConfigPath,
  resolveContractLockPath: resolveBuildchainContractLockPath,
  resolveKfd3SurfaceRegistryPath,
  resolveReleasePassportPath,
});
