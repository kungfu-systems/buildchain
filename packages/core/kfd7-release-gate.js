import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import kfdPackageJson from "@kungfu-tech/kfd/package.json" with { type: "json" };
import kfdStandards from "@kungfu-tech/kfd/standards.json" with { type: "json" };
import kfd2TrustTaxonomySchema from "@kungfu-tech/kfd/schemas/kfd-2/trust-taxonomy.schema.json" with { type: "json" };
import kfd7ActionContractSchema from "@kungfu-tech/kfd/schemas/kfd-7/action-contract.schema.json" with { type: "json" };

export const KFD7_RELEASE_GATE_INPUT_CONTRACT = "kungfu-buildchain-kfd-7-release-gate-input";
export const KFD7_EVIDENCE_REPORT_CONTRACT = "kungfu-buildchain-kfd-7-evidence-report";
export const KFD7_RELEASE_GATE_CONTRACT = "kungfu-buildchain-kfd-7-release-gate";

const REQUIRED_TEST_KINDS = Object.freeze(["positive", "negative"]);
const REQUIRED_EXPERIMENT_CATEGORIES = Object.freeze([
  "role-deletion-or-fusion",
  "export-import-rebuild",
  "backend-migration",
  "concurrency-retry-compensation",
  "warrant-decay-revocation",
  "atlas-staleness-loss",
  "pursuit-continuity-settlement",
  "episode-replay-contraction",
  "cold-start-continuation",
]);

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function issue(level, code, message, details = {}) {
  return { level, code, message, details };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Json(value) {
  return sha256Bytes(stableJson(value));
}

function normalizeSha256(value) {
  return optionalString(value).replace(/^sha256:/, "").toLowerCase();
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(normalizeSha256(value));
}

function repoRelativePath(value, label) {
  const normalized = optionalString(value).replace(/\\/g, "/");
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  return normalized;
}

function readEvidenceFile(cwd, descriptor, label) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error(`${label} must be an object`);
  }
  const relativePath = repoRelativePath(descriptor.path, `${label}.path`);
  const filePath = path.resolve(cwd, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { path: relativePath, expectedSha256: normalizeSha256(descriptor.sha256), actualSha256: "", value: undefined };
  }
  const bytes = fs.readFileSync(filePath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return {
    path: relativePath,
    expectedSha256: normalizeSha256(descriptor.sha256),
    actualSha256: sha256Bytes(bytes),
    canonicalSha256: sha256Json(value),
    value,
  };
}

function kfd7Metadata() {
  const standard = kfdStandards.standards?.["kfd-7"];
  if (!standard?.schemaIds?.actionContract || !standard?.schemaPaths?.actionContract) {
    throw new Error("KFD package does not expose the KFD-7 action-contract schema");
  }
  return {
    key: standard.key || "kfd-7",
    id: standard.id || "KFD-7",
    label: standard.label || "KFD-7",
    title: standard.title || "",
    status: standard.status || "",
    revision: standard.revision || 0,
    schemaIds: { ...standard.schemaIds },
    schemaPaths: { ...standard.schemaPaths },
    package: {
      name: kfdPackageJson.name,
      version: kfdPackageJson.version,
      repository: kfdPackageJson.repository?.url || "",
    },
  };
}

function createSchemaValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  ajv.addSchema(kfd2TrustTaxonomySchema);
  ajv.addSchema(kfd7ActionContractSchema);
  return {
    actionContract: ajv.getSchema(kfd7ActionContractSchema.$id),
    residualRisk: ajv.getSchema(`${kfd2TrustTaxonomySchema.$id}#/$defs/residualRisk`),
  };
}

function schemaIssues(validate, value, codePrefix) {
  if (validate(value)) return [];
  return (validate.errors || []).map((entry) => issue(
    "error",
    `${codePrefix}.schema`,
    `${entry.instancePath || "/"} ${entry.message || "does not match the schema"}`,
    { keyword: entry.keyword, params: entry.params },
  ));
}

function validateEvidenceReport(report, declaration, descriptor, label) {
  const issues = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return [issue("error", `${label}.missing`, `${label} must contain a JSON evidence report`)];
  }
  if (report.schemaVersion !== 1 || report.contract !== KFD7_EVIDENCE_REPORT_CONTRACT) {
    issues.push(issue("error", `${label}.contract`, `${label} must use ${KFD7_EVIDENCE_REPORT_CONTRACT} schemaVersion 1`));
  }
  for (const [field, expected] of [
    ["profileId", declaration.profile.id],
    ["profileVersion", declaration.profile.version],
    ["stateMachineVersion", declaration.profile.stateMachineVersion],
    ["sourceSha", declaration.source.sha],
  ]) {
    if (optionalString(report[field]) !== optionalString(expected)) {
      issues.push(issue("error", `${label}.${field}`, `${label}.${field} does not match the frozen declaration`, {
        expected: optionalString(expected), actual: optionalString(report[field]),
      }));
    }
  }
  if (
    (descriptor.kind && optionalString(report.kind) !== descriptor.kind) ||
    (descriptor.category && optionalString(report.category) !== descriptor.category)
  ) {
    issues.push(issue("error", `${label}.classification`, `${label} kind/category does not match its declaration`));
  }
  const expectedOutcome = descriptor.kind === "negative" ? "fail" : optionalString(descriptor.expectedOutcome || "pass");
  if (optionalString(report.outcome) !== expectedOutcome || report.matchedExpectation !== true) {
    issues.push(issue("error", `${label}.outcome`, `${label} did not retain the expected outcome`, {
      expectedOutcome, actualOutcome: optionalString(report.outcome), matchedExpectation: report.matchedExpectation === true,
    }));
  }
  if (!Array.isArray(report.checks) || report.checks.length === 0) {
    issues.push(issue("error", `${label}.checks`, `${label} must retain named checks`));
  }
  return issues;
}

function normalizeDeclaration(raw, { cwd, artifactRoot, verifiedAt, validators, metadata }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("KFD-7 declaration must be a JSON object");
  }
  const declaration = {
    schemaVersion: raw.schemaVersion,
    contract: optionalString(raw.contract),
    standard: optionalString(raw.standard),
    profile: {
      id: optionalString(raw.profile?.id),
      version: optionalString(raw.profile?.version),
      stateMachineVersion: optionalString(raw.profile?.stateMachineVersion),
      actionContract: raw.profile?.actionContract,
      verifierReport: raw.profile?.verifierReport,
    },
    source: { sha: optionalString(raw.source?.sha) },
    surfaces: Array.isArray(raw.surfaces) ? raw.surfaces : [],
    testEvidence: Array.isArray(raw.testEvidence) ? raw.testEvidence : [],
    experiments: Array.isArray(raw.experiments) ? raw.experiments : [],
    residualRisk: Array.isArray(raw.residualRisk) ? raw.residualRisk : [],
    responsibility: raw.responsibility && typeof raw.responsibility === "object" && !Array.isArray(raw.responsibility)
      ? { ...raw.responsibility }
      : {},
    nonClaims: Array.isArray(raw.nonClaims) ? raw.nonClaims.map(optionalString).filter(Boolean) : [],
  };
  const issues = [];
  if (declaration.schemaVersion !== 1 || declaration.contract !== KFD7_RELEASE_GATE_INPUT_CONTRACT) {
    issues.push(issue("error", "kfd-7.declaration.contract", `declaration must use ${KFD7_RELEASE_GATE_INPUT_CONTRACT} schemaVersion 1`));
  }
  if (declaration.standard !== metadata.key) {
    issues.push(issue("error", "kfd-7.declaration.standard", `declaration.standard must be ${metadata.key}`));
  }
  if (!declaration.profile.id || !declaration.profile.version || !declaration.profile.stateMachineVersion) {
    issues.push(issue("error", "kfd-7.declaration.profile", "profile id, version, and stateMachineVersion are required"));
  }
  if (!/^[0-9a-f]{40}$/.test(declaration.source.sha)) {
    issues.push(issue("error", "kfd-7.declaration.source", "source.sha must be an exact 40-character Git SHA"));
  }

  const actionContract = readEvidenceFile(cwd, declaration.profile.actionContract, "profile.actionContract");
  const verifierReport = readEvidenceFile(cwd, declaration.profile.verifierReport, "profile.verifierReport");
  for (const [label, evidence] of [["action-contract", actionContract], ["verifier-report", verifierReport]]) {
    if (!evidence.value) issues.push(issue("error", `kfd-7.${label}.missing`, `${label} evidence is missing`, { path: evidence.path }));
    if (!isSha256(evidence.expectedSha256) || evidence.expectedSha256 !== evidence.actualSha256) {
      issues.push(issue("error", `kfd-7.${label}.digest`, `${label} evidence digest does not match`, {
        path: evidence.path, expected: evidence.expectedSha256, actual: evidence.actualSha256,
      }));
    }
  }
  if (actionContract.value) {
    issues.push(...schemaIssues(validators.actionContract, actionContract.value, "kfd-7.action-contract"));
    if (actionContract.value.profile?.id !== declaration.profile.id) {
      issues.push(issue("error", "kfd-7.profile.unknown", "declaration profile id is not the KFD-7 action-contract profile id"));
    }
    if (actionContract.value.profile?.version !== declaration.profile.version || actionContract.value.profile?.version !== declaration.profile.stateMachineVersion) {
      issues.push(issue("error", "kfd-7.profile.version", "profile and state-machine versions must match the KFD-7 action contract"));
    }
  }
  if (verifierReport.value) {
    const report = verifierReport.value;
    if (
      report.schemaVersion !== 1 ||
      report.contract !== "kfd.verification-report/v1" ||
      report.profile !== metadata.schemaIds.actionContract ||
      report.valid !== true ||
      report.offline !== true ||
      !Array.isArray(report.checks) ||
      !report.checks.some((entry) => entry.id === "json-schema" && entry.status === "pass") ||
      !Array.isArray(report.issues) || report.issues.length > 0
    ) {
      issues.push(issue("error", "kfd-7.verifier.mismatch", "KFD verifier report does not prove the frozen action contract against the packaged KFD-7 schema"));
    }
  }

  const resolveReportDescriptors = (entries, label) => entries.map((descriptor, index) => {
    const evidence = readEvidenceFile(cwd, descriptor, `${label}[${index}]`);
    const reportIssues = [];
    if (!evidence.value) reportIssues.push(issue("error", `kfd-7.${label}.missing`, `${label}[${index}] is missing`, { path: evidence.path }));
    if (!isSha256(evidence.expectedSha256) || evidence.expectedSha256 !== evidence.actualSha256) {
      reportIssues.push(issue("error", `kfd-7.${label}.digest`, `${label}[${index}] digest does not match`, {
        path: evidence.path, expected: evidence.expectedSha256, actual: evidence.actualSha256,
      }));
    }
    if (evidence.value) reportIssues.push(...validateEvidenceReport(evidence.value, declaration, descriptor, `${label}[${index}]`));
    issues.push(...reportIssues);
    return {
      id: optionalString(descriptor.id),
      kind: optionalString(descriptor.kind),
      category: optionalString(descriptor.category),
      expectedOutcome: optionalString(descriptor.expectedOutcome || (descriptor.kind === "negative" ? "fail" : "pass")),
      path: evidence.path,
      sha256: evidence.actualSha256,
      canonicalSha256: evidence.canonicalSha256 || "",
      report: evidence.value,
      status: reportIssues.length === 0 ? "passed" : "failed",
    };
  });
  const testEvidence = resolveReportDescriptors(declaration.testEvidence, "test-evidence");
  const experiments = resolveReportDescriptors(declaration.experiments, "experiment");
  for (const kind of REQUIRED_TEST_KINDS) {
    if (!testEvidence.some((entry) => entry.kind === kind)) {
      issues.push(issue("error", `kfd-7.test-evidence.${kind}.missing`, `at least one ${kind} transition report is required`));
    }
  }
  for (const category of REQUIRED_EXPERIMENT_CATEGORIES) {
    if (!experiments.some((entry) => entry.category === category)) {
      issues.push(issue("error", `kfd-7.experiment.${category}.missing`, `${category} evidence is required`));
    }
  }

  const surfaces = declaration.surfaces.map((surface, index) => {
    const id = optionalString(surface.id);
    const sourcePath = repoRelativePath(surface.sourcePath, `surfaces[${index}].sourcePath`);
    const artifactPath = repoRelativePath(surface.artifactPath, `surfaces[${index}].artifactPath`);
    const expectedSha256 = normalizeSha256(surface.sha256);
    const sourceFile = path.resolve(cwd, sourcePath);
    const artifactFile = path.resolve(artifactRoot || cwd, artifactPath);
    const sourceSha256 = fs.existsSync(sourceFile) && fs.statSync(sourceFile).isFile() ? sha256Bytes(fs.readFileSync(sourceFile)) : "";
    const artifactSha256 = fs.existsSync(artifactFile) && fs.statSync(artifactFile).isFile() ? sha256Bytes(fs.readFileSync(artifactFile)) : "";
    const status = Boolean(id && isSha256(expectedSha256) && sourceSha256 === expectedSha256 && artifactSha256 === expectedSha256)
      ? "passed"
      : "failed";
    if (status === "failed") {
      issues.push(issue("error", `kfd-7.surface.${id || index}`, "declared source and artifact surface must both match the frozen digest", {
        sourcePath, artifactPath, expectedSha256, sourceSha256, artifactSha256,
      }));
    }
    return { id, sourcePath, artifactPath, expectedSha256, sourceSha256, artifactSha256, status };
  });
  if (surfaces.length === 0) issues.push(issue("error", "kfd-7.surfaces.empty", "at least one source-to-artifact surface is required"));

  for (const [index, risk] of declaration.residualRisk.entries()) {
    issues.push(...schemaIssues(validators.residualRisk, risk, `kfd-7.residual-risk[${index}]`));
  }
  for (const field of ["profileOwner", "evidenceOwner", "proofOwner"]) {
    if (!optionalString(declaration.responsibility[field])) {
      issues.push(issue("error", `kfd-7.responsibility.${field}`, `responsibility.${field} is required`));
    }
  }
  if (declaration.nonClaims.length === 0) {
    issues.push(issue("error", "kfd-7.non-claims.empty", "declaration must state at least one non-claim"));
  }

  const errors = issues.filter((entry) => entry.level === "error");
  const provisional = actionContract.value?.profile?.qualificationStatus !== "qualified" || actionContract.value?.activation?.decision !== "activate";
  const status = errors.length > 0 ? "failed" : declaration.residualRisk.length > 0 || provisional ? "downgraded" : "passed";
  return {
    id: declaration.profile.id,
    status,
    gateResult: status === "passed" ? "pass" : status === "downgraded" ? "warning" : "fail",
    verifiedAt,
    declarationSha256: sha256Json(raw),
    declaration,
    actionContract: {
      path: actionContract.path,
      sha256: actionContract.actualSha256,
      canonicalSha256: actionContract.canonicalSha256 || "",
      value: actionContract.value,
    },
    verifierReport: {
      path: verifierReport.path,
      sha256: verifierReport.actualSha256,
      canonicalSha256: verifierReport.canonicalSha256 || "",
      value: verifierReport.value,
    },
    testEvidence,
    experiments,
    surfaces,
    residualRisk: declaration.residualRisk,
    responsibility: declaration.responsibility,
    nonClaims: declaration.nonClaims,
    issues,
  };
}

export function createKfd7ReleaseGateEvidence({
  cwd = process.cwd(),
  artifactRoot = "",
  declarations = [],
  verifiedAt = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(declarations) || declarations.filter(Boolean).length === 0) return undefined;
  const metadata = kfd7Metadata();
  const validators = createSchemaValidators();
  const profiles = declarations.filter(Boolean).map((declaration) => normalizeDeclaration(declaration, {
    cwd,
    artifactRoot: artifactRoot ? path.resolve(cwd, artifactRoot) : cwd,
    verifiedAt,
    validators,
    metadata,
  }));
  const status = profiles.some((profile) => profile.status === "failed")
    ? "failed"
    : profiles.some((profile) => profile.status === "downgraded")
      ? "downgraded"
      : "passed";
  return {
    key: metadata.key,
    passportSection: {
      schemaVersion: 1,
      contract: KFD7_RELEASE_GATE_CONTRACT,
      status,
      gateResult: status === "passed" ? "pass" : status === "downgraded" ? "warning" : "fail",
      metadata: {
        standard: { key: metadata.key, id: metadata.id, label: metadata.label, title: metadata.title, status: metadata.status, revision: metadata.revision },
        schemas: { ids: metadata.schemaIds, paths: metadata.schemaPaths },
        package: metadata.package,
      },
      responsibilityBoundary: {
        product: "Declares the Profile, implementation surfaces, retained tests and experiments, and residual risk.",
        kfd: "Owns the KFD-7 action-contract schema and independent verifier semantics.",
        buildchain: "Checks declaration/evidence closure and records pass, warning, or fail without judging real-world work quality.",
      },
      profiles,
    },
  };
}

export function validateKfd7ReleaseGateEvidence(section) {
  if (!section) return [];
  const issues = [];
  const metadata = kfd7Metadata();
  const validators = createSchemaValidators();
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return [issue("error", "kfd-7.object", "kfd-7 release gate evidence must be an object")];
  }
  if (section.schemaVersion !== 1 || section.contract !== KFD7_RELEASE_GATE_CONTRACT) {
    issues.push(issue("error", "kfd-7.contract", `kfd-7 section must use ${KFD7_RELEASE_GATE_CONTRACT} schemaVersion 1`));
  }
  if (section.metadata?.standard?.key !== metadata.key || section.metadata?.package?.version !== metadata.package.version) {
    issues.push(issue("error", "kfd-7.metadata", "kfd-7 metadata must match the installed KFD package"));
  }
  const profiles = Array.isArray(section.profiles) ? section.profiles : [];
  if (profiles.length === 0) issues.push(issue("error", "kfd-7.profiles.empty", "kfd-7 section must contain at least one Profile"));
  for (const [index, profile] of profiles.entries()) {
    if (profile.actionContract?.value) {
      issues.push(...schemaIssues(validators.actionContract, profile.actionContract.value, `kfd-7.profiles[${index}].action-contract`));
      if (profile.actionContract.canonicalSha256 !== sha256Json(profile.actionContract.value)) {
        issues.push(issue("error", `kfd-7.profiles[${index}].action-contract.canonical-digest`, "embedded action contract digest drifted"));
      }
    } else {
      issues.push(issue("error", `kfd-7.profiles[${index}].action-contract.missing`, "embedded action contract is required"));
    }
    if (profile.verifierReport?.canonicalSha256 !== sha256Json(profile.verifierReport?.value)) {
      issues.push(issue("error", `kfd-7.profiles[${index}].verifier-report.canonical-digest`, "embedded KFD verifier report digest drifted"));
    }
    for (const evidence of [...(profile.testEvidence || []), ...(profile.experiments || [])]) {
      if (!evidence.report || evidence.canonicalSha256 !== sha256Json(evidence.report)) {
        issues.push(issue("error", `kfd-7.profiles[${index}].evidence-digest`, "embedded KFD-7 evidence report digest drifted", { id: evidence.id || "" }));
      }
    }
    for (const [riskIndex, risk] of (profile.residualRisk || []).entries()) {
      issues.push(...schemaIssues(validators.residualRisk, risk, `kfd-7.profiles[${index}].residual-risk[${riskIndex}]`));
    }
    if (profile.status === "failed" || profile.gateResult === "fail" || (profile.issues || []).some((entry) => entry.level === "error")) {
      issues.push(issue("error", `kfd-7.profiles[${index}].failed`, "KFD-7 Profile release gate failed", { id: profile.id || "" }));
    }
  }
  const expectedStatus = profiles.some((profile) => profile.status === "failed")
    ? "failed"
    : profiles.some((profile) => profile.status === "downgraded")
      ? "downgraded"
      : "passed";
  if (section.status !== expectedStatus) {
    issues.push(issue("error", "kfd-7.status", "kfd-7 aggregate status does not match Profile results", { expected: expectedStatus, actual: section.status }));
  }
  return issues;
}
