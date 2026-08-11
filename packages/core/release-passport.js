import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import {
  createKfd1ReleaseGateEvidence,
  createKfd3CollaborationInterfaceReleaseGateEvidence,
  resolveKfd1Metadata,
  resolveKfd3Metadata,
  validateKfd2TrustTaxonomyEntry,
  validateKfd1ReleaseGateEvidence,
  validateKfd3CollaborationInterfaceReleaseGateEvidence,
} from "./kfd-gate.js";
import {
  RELEASE_CHECK_REPORT_CONTRACT,
  RELEASE_PASSPORT_CONTRACT,
  buildReleaseArtifactEvidence,
  collectKfdAdopterReleaseEvidence,
  defaultReleaseAgentIndex as defaultAgentIndex,
  defaultReleaseImpact as defaultImpact,
  defaultReleaseLlmsText as defaultLlmsText,
  defaultReleaseProductMechanism as defaultProductMechanism,
  prepareReleasePassportKfdSections,
  resolveReleasePassportVerificationInputs,
  validateKfdAdopterReleaseEvidence,
} from "./release-passport-contract.js";
import { createSurfaceTimestampPolicy } from "./surface-manifest.js";
import { validatePublishEvidence as validateTransactionPublishEvidence } from "./publish-transaction.js";
import { normalizeControllerReceiptReferences } from "./controller-evidence.js";
import {
  normalizeGitHubArtifactAttestationPolicy,
} from "./github-artifact-attestation.js";

export { RELEASE_CHECK_REPORT_CONTRACT, RELEASE_PASSPORT_CONTRACT };
export const ARTIFACT_EVIDENCE_CONTRACT = "kungfu-buildchain-artifact-evidence";
export const IMPACT_LEDGER_CONTRACT = "kungfu-buildchain-impact";
export const AGENT_INDEX_CONTRACT = "kungfu-buildchain-agent-index";
export const PRODUCT_MECHANISM_CONTRACT = "kungfu-buildchain-product-mechanism";
export const RELEASE_EVIDENCE_ATTACHMENT_CONTRACT = "kungfu-buildchain-release-evidence-attachment";
export const KFD2_RELEASE_TRUST_PASSPORT_CONTRACT = "kungfu-buildchain-kfd-2-release-trust-passport-audit";
export const KFD2_TRUST_PROOF_CONTRACT = "kungfu-buildchain-kfd-2-trust-proof";
export const INVARIANT_PASSPORT_GATE_CONTRACT = "buildchain.invariant-passport-gate/v1";
export const KFD_AGENT_HUB_RELEASE_EVIDENCE_CONTRACT = "kungfu-buildchain-kfd-agent-hub-release-evidence/v1";

const CONTRACTS = new Set([
  RELEASE_PASSPORT_CONTRACT,
  ARTIFACT_EVIDENCE_CONTRACT,
  IMPACT_LEDGER_CONTRACT,
  AGENT_INDEX_CONTRACT,
  PRODUCT_MECHANISM_CONTRACT,
  RELEASE_EVIDENCE_ATTACHMENT_CONTRACT,
]);

function nowIso() {
  return new Date().toISOString();
}

function nonEmptyString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value);
}

const VERSION_IMPACT_ORDER = new Map([
  ["unknown", 0],
  ["patch", 1],
  ["minor", 2],
  ["major", 3],
]);

function normalizeImpactLevel(value, fallback = "unknown") {
  const normalized = optionalString(value || fallback).toLowerCase();
  return VERSION_IMPACT_ORDER.has(normalized) ? normalized : optionalString(value || fallback);
}

function highestImpactLevel(levels = []) {
  let highest = "unknown";
  for (const level of levels) {
    const normalized = normalizeImpactLevel(level);
    if ((VERSION_IMPACT_ORDER.get(normalized) ?? -1) > (VERSION_IMPACT_ORDER.get(highest) ?? -1)) {
      highest = normalized;
    }
  }
  return highest;
}

function surfaceImpactRequirement({ passport = {}, impact = {} } = {}) {
  const release = passport?.release && typeof passport.release === "object" ? passport.release : {};
  const impactRelease = impact?.release && typeof impact.release === "object" ? impact.release : {};
  const channel = optionalString(release.channel || impactRelease.channel).toLowerCase();
  const targetRef = optionalString(
    release.targetRef ||
    release.target_ref ||
    impactRelease.targetRef ||
    impactRelease.target_ref,
  ).toLowerCase();
  if (channel === "release" || targetRef.startsWith("release/")) {
    return {
      required: true,
      type: "production-release",
      reason: "production release passports require surfaceImpacts[] so agents can audit the final version impact",
      channel,
      targetRef,
    };
  }
  if (channel === "major" || targetRef === "publish-gate/major" || targetRef === "major-gate") {
    return {
      required: true,
      type: "major-gate",
      reason: "major publish gates require surfaceImpacts[] so breaking-surface rationale is explicit",
      channel,
      targetRef,
    };
  }
  return {
    required: false,
    type: channel || (targetRef ? "non-production-release" : "legacy"),
    reason: "surfaceImpacts[] is optional for alpha, local, and legacy passport contexts",
    channel,
    targetRef,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function invariantSemanticPreimage(passport) {
  const value = structuredClone(passport);
  delete value.passportRoot;
  delete value.observedAt;
  return value;
}

function normalizeInvariantPassport(meta, index = 0) {
  const value = meta?.value;
  const label = `invariantPassportJsons[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  for (const field of ["schema", "product", "canonicalization", "passportRoot", "contractRoot", "registryRoot", "verdict"]) {
    nonEmptyString(value[field], `${label}.${field}`);
  }
  if (value.canonicalization !== "stable-json-sha256-v1") {
    throw new Error(`${label}.canonicalization must be stable-json-sha256-v1`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(value.passportRoot)) {
    throw new Error(`${label}.passportRoot must be sha256:<64-lowercase-hex>`);
  }
  const expectedRoot = `sha256:${sha256Text(stableJson(invariantSemanticPreimage(value)))}`;
  if (value.passportRoot !== expectedRoot) {
    throw new Error(`${label}.passportRoot mismatch: expected ${expectedRoot}, got ${value.passportRoot}`);
  }
  if (value.verdict !== "verified") {
    throw new Error(`${label}.verdict must be verified, got ${value.verdict}`);
  }
  if (value.coverage?.complete !== true) {
    throw new Error(`${label}.coverage.complete must be true`);
  }
  if (value.source?.dirty !== false) {
    throw new Error(`${label}.source.dirty must be false`);
  }
  if (!/^[0-9a-f]{40}$/.test(optionalString(value.source?.revision))) {
    throw new Error(`${label}.source.revision must be an exact 40-hex revision`);
  }
  const platforms = Array.isArray(value.coverage?.platforms)
    ? [...new Set(value.coverage.platforms.map(String))].sort()
    : [];
  if (platforms.length === 0) throw new Error(`${label}.coverage.platforms must be non-empty`);
  if (!Array.isArray(value.residualRisk)) throw new Error(`${label}.residualRisk must be an array`);
  return {
    path: optionalString(meta.path),
    sha256: optionalString(meta.sha256),
    schema: value.schema,
    product: value.product,
    passportRoot: value.passportRoot,
    contractRoot: value.contractRoot,
    registryRoot: value.registryRoot,
    verdict: value.verdict,
    source: structuredClone(value.source),
    coverage: structuredClone(value.coverage),
    platforms,
    residualRisk: structuredClone(value.residualRisk),
  };
}

export function createInvariantPassportGate(passportMetas = []) {
  const passports = passportMetas.filter((meta) => meta?.value).map(normalizeInvariantPassport);
  if (passports.length === 0) return undefined;
  return {
    contract: INVARIANT_PASSPORT_GATE_CONTRACT,
    result: "passed",
    passports,
    responsibility: {
      invariantSemanticsOwner: "consumer",
      passportVerificationOwner: "consumer",
      releaseAdmissionOwner: "Buildchain",
    },
  };
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveJsonInputPath(input, { cwd = process.cwd() } = {}) {
  const normalized = String(input || "").trim();
  if (!normalized) {
    return "";
  }
  if (path.isAbsolute(normalized)) {
    return fs.existsSync(normalized) ? normalized : "";
  }
  const cwdCandidate = cwd ? path.resolve(cwd, normalized) : "";
  if (cwdCandidate && fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }
  return fs.existsSync(normalized) ? path.resolve(normalized) : "";
}

function jsonInputError({ input, label, cwd, cause }) {
  const suffix = cwd ? ` or an existing JSON file path relative to ${cwd}` : " or an existing JSON file path";
  return new Error(`${label} must be valid JSON${suffix}; received ${JSON.stringify(input)}`, { cause });
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

function normalizeReleaseEvidenceAttachment(meta, {
  cwd,
  expectedSourceSha,
  expectedTag,
  expectedChannel,
  index,
} = {}) {
  const document = meta?.value;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`releaseEvidenceJsons[${index}] must be a JSON object`);
  }
  const inputPath = resolveJsonInputPath(meta.path, { cwd });
  if (!inputPath) {
    throw new Error(`releaseEvidenceJsons[${index}] must be an existing JSON file path`);
  }
  if (Number(document.schemaVersion) !== 1) {
    throw new Error(`releaseEvidenceJsons[${index}].schemaVersion must be 1`);
  }
  const id = nonEmptyString(document.id, `releaseEvidenceJsons[${index}].id`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`releaseEvidenceJsons[${index}].id must use only letters, digits, dot, underscore, or hyphen`);
  }
  const contract = nonEmptyString(document.contract, `releaseEvidenceJsons[${index}].contract`);
  const release = document.release;
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error(`releaseEvidenceJsons[${index}].release must be a JSON object`);
  }
  const sourceSha = nonEmptyString(release.sourceSha, `releaseEvidenceJsons[${index}].release.sourceSha`);
  const tag = nonEmptyString(release.tag, `releaseEvidenceJsons[${index}].release.tag`);
  const channel = nonEmptyString(release.channel, `releaseEvidenceJsons[${index}].release.channel`);
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) {
    throw new Error(`releaseEvidenceJsons[${index}].release.sourceSha must be a full 40-character Git SHA`);
  }
  if (!expectedSourceSha || sourceSha !== expectedSourceSha) {
    throw new Error(`releaseEvidenceJsons[${index}].release.sourceSha must match the release passport source SHA`);
  }
  if (!expectedTag || tag !== expectedTag) {
    throw new Error(`releaseEvidenceJsons[${index}].release.tag must match the release passport tag`);
  }
  if (!expectedChannel || channel !== expectedChannel) {
    throw new Error(`releaseEvidenceJsons[${index}].release.channel must match the release passport channel`);
  }
  const relativePath = `release-evidence-${id}.json`;
  return {
    document,
    inputPath,
    reference: {
      schemaVersion: 1,
      contract: RELEASE_EVIDENCE_ATTACHMENT_CONTRACT,
      id,
      kind: optionalString(document.kind || "product-release-evidence"),
      documentContract: contract,
      path: relativePath,
      sha256: sha256Text(stableJson(document)),
      release: { sourceSha, tag, channel },
    },
  };
}

function inferPlatformFromName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.includes("apple-darwin") || lower.includes("darwin") || lower.includes("macos")) {
    return lower.includes("aarch64") || lower.includes("arm64") ? "darwin-arm64" : "darwin-x64";
  }
  if (lower.includes("windows") || lower.includes("pc-windows") || lower.endsWith(".zip")) {
    return "windows-x64";
  }
  if (lower.includes("linux") || lower.includes("unknown-linux")) {
    return lower.includes("aarch64") || lower.includes("arm64") ? "linux-arm64" : "linux-x64";
  }
  return "";
}

function normalizeAsset(asset, index = 0) {
  const name = nonEmptyString(asset.name || asset.filename, `assets[${index}].name`);
  const digest = optionalString(asset.digest || asset.sha256 || asset.checksum);
  const sha256 = digest.replace(/^sha256:/, "");
  return {
    name,
    kind: optionalString(asset.kind || "release-asset"),
    platform: optionalString(asset.platform || inferPlatformFromName(name)),
    size: Number(asset.size || asset.sizeBytes || 0),
    url: optionalString(asset.browser_download_url || asset.downloadUrl || asset.url),
    githubAssetId: optionalString(asset.id || asset.githubAssetId),
    sha256,
    sourcePath: optionalString(asset.path || asset.sourcePath),
  };
}

function parseJsonInput(value, fallback = undefined, { cwd = process.cwd(), label = "JSON input" } = {}) {
  const input = String(value || "").trim();
  if (!input) {
    return fallback;
  }
  const filePath = resolveJsonInputPath(input, { cwd });
  if (filePath) {
    return readJsonFile(filePath);
  }
  try {
    return JSON.parse(input);
  } catch (error) {
    throw jsonInputError({ input, label, cwd, cause: error });
  }
}

function parseJsonInputWithMeta(value, fallback = undefined, { cwd = process.cwd(), label = "JSON input" } = {}) {
  const input = String(value || "").trim();
  if (!input) {
    return { value: fallback, path: "", sha256: "" };
  }
  const filePath = resolveJsonInputPath(input, { cwd });
  if (filePath) {
    return {
      value: readJsonFile(filePath),
      path: input,
      sha256: sha256File(filePath),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw jsonInputError({ input, label, cwd, cause: error });
  }
  return {
    value: parsed,
    path: "",
    sha256: sha256Text(stableJson(parsed)),
  };
}

function mergeAuthoritativePassportBase(passport, basePassport = undefined, { requireKfd = false } = {}) {
  if (!basePassport) {
    if (requireKfd) {
      throw new Error("release passport base with KFD evidence is required");
    }
    return passport;
  }
  if (typeof basePassport !== "object" || Array.isArray(basePassport)) {
    throw new Error("release passport base must be a JSON object");
  }
  const kfdKeys = ["kfd-1", "kfd-2", "kfd-3"];
  const missingKfd = kfdKeys.filter((key) => (
    !basePassport[key] ||
    typeof basePassport[key] !== "object" ||
    Array.isArray(basePassport[key])
  ));
  if (requireKfd && missingKfd.length > 0) {
    throw new Error(`release passport base is missing required KFD sections: ${missingKfd.join(", ")}`);
  }
  const merged = {
    ...passport,
    release: {
      ...(passport.release && typeof passport.release === "object" && !Array.isArray(passport.release) ? passport.release : {}),
      ...(basePassport.release && typeof basePassport.release === "object" && !Array.isArray(basePassport.release) ? basePassport.release : {}),
    },
    evidence: {
      ...(passport.evidence && typeof passport.evidence === "object" && !Array.isArray(passport.evidence) ? passport.evidence : {}),
      kfd1: basePassport.evidence?.kfd1 || passport.evidence?.kfd1 || "",
      kfd2: basePassport.evidence?.kfd2 || passport.evidence?.kfd2 || "",
      kfd3: basePassport.evidence?.kfd3 || passport.evidence?.kfd3 || "",
    },
  };
  for (const key of ["versionImpact", "surfaceImpacts"]) {
    if (basePassport[key] !== undefined) {
      merged[key] = basePassport[key];
    }
  }
  if (basePassport.controllerReceipts !== undefined) {
    merged.controllerReceipts = basePassport.controllerReceipts;
  }
  for (const key of kfdKeys) {
    if (basePassport[key] && typeof basePassport[key] === "object" && !Array.isArray(basePassport[key])) {
      merged[key] = basePassport[key];
    }
  }
  return merged;
}

function mergeAuthoritativeImpactBase(impact, basePassport = undefined) {
  if (!basePassport || typeof basePassport !== "object" || Array.isArray(basePassport)) {
    return impact;
  }
  const merged = { ...impact };
  if (optionalString(impact?.release?.version)) {
    return merged;
  }
  if (basePassport.versionImpact && typeof basePassport.versionImpact === "object" && !Array.isArray(basePassport.versionImpact)) {
    merged.versionImpact = {
      ...(impact.versionImpact && typeof impact.versionImpact === "object" && !Array.isArray(impact.versionImpact) ? impact.versionImpact : {}),
      ...basePassport.versionImpact,
    };
  }
  if (Array.isArray(basePassport.surfaceImpacts)) {
    merged.surfaceImpacts = basePassport.surfaceImpacts;
  }
  for (const key of ["classification", "breaking", "security", "migrationRequired", "summary"]) {
    if (basePassport[key] !== undefined) {
      merged[key] = basePassport[key];
    }
  }
  return merged;
}

function parseJsonCommandOutput({ command = "", cwd = process.cwd(), label = "command" } = {}) {
  const normalized = String(command || "").trim();
  if (!normalized) {
    return { value: undefined, path: "", sha256: "" };
  }
  const result = spawnSync(normalized, [], {
    cwd,
    shell: true,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(`${label} exited with ${result.status}${stderr ? `: ${stderr.slice(-1000)}` : ""}`);
  }
  const stdout = String(result.stdout || "").trim();
  if (!stdout) {
    throw new Error(`${label} produced no JSON on stdout`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} output must be valid JSON: ${error.message}`, { cause: error });
  }
  return {
    value: parsed,
    path: "",
    sha256: sha256Text(stableJson(parsed)),
  };
}

function discoverAssetsFromDir(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry, index) => {
      const filePath = path.join(dir, entry.name);
      return normalizeAsset({
        name: entry.name,
        path: filePath,
        size: fs.statSync(filePath).size,
        sha256: sha256File(filePath),
      }, index);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readPackageVersion(cwd) {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) {
    return "";
  }
  try {
    return readJsonFile(packagePath).version || "";
  } catch {
    return "";
  }
}

function normalizePackageEntry(entry = {}) {
  return {
    name: optionalString(entry.name),
    version: optionalString(entry.version || entry.ref),
    distTag: optionalString(entry.distTag || entry.dist_tag),
    digest: optionalString(entry.digest || entry.integrity || entry.sha256 || entry.shasum),
    registry: optionalString(entry.registry),
    platform: optionalString(entry.platform),
    action: optionalString(entry.action),
  };
}

function normalizePackageSet(value = undefined, { packageName = "", packageVersion = "", publish = {} } = {}) {
  if (!value) {
    return undefined;
  }
  const rawMain = value.main || value.mainPackage || {
    name: value.main_package || packageName,
    version: value.version || packageVersion,
    distTag: value.distTag || value.dist_tag || publish.distTag,
  };
  const platforms = Array.isArray(value.platforms)
    ? value.platforms.map((entry) => normalizePackageEntry(entry)).filter((entry) => entry.name || entry.version)
    : [];
  return {
    order: optionalString(value.order || value.packageSetOrder || value.package_set_order || publish.packageSetOrder),
    registry: optionalString(value.registry || publish.registry),
    main: normalizePackageEntry(rawMain),
    platforms,
  };
}

function normalizeAnchorManifest(meta) {
  const value = meta?.value;
  if (!value) {
    return undefined;
  }
  return {
    path: optionalString(value.path || meta.path),
    sha256: optionalString(value.sha256 || meta.sha256),
    fields: value.fields && typeof value.fields === "object" && !Array.isArray(value.fields)
      ? value.fields
      : value,
  };
}

function normalizeEvidenceDocument(meta, label) {
  const value = meta?.value;
  if (!value) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return {
    path: optionalString(meta.path),
    sha256: optionalString(meta.sha256),
    fields: value,
  };
}

function normalizeKfdAgentHubEvidence(meta) {
  const value = meta?.value;
  if (!value) return undefined;
  if (value.contract !== "kungfu-buildchain-kfd-agent-hub-evidence/v1") {
    throw new Error("kfdAgentHubEvidence must be kungfu-buildchain-kfd-agent-hub-evidence/v1");
  }
  if (value.qualifying !== false || value.certification !== false) {
    throw new Error("kfdAgentHubEvidence must remain nonqualifying and non-certifying");
  }
  for (const [label, root] of [
    ["report.digest", value.report?.digest],
    ["lock.root", value.lock?.root],
    ["scope.adapterArtifactDigest", value.scope?.adapterArtifactDigest],
  ]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(optionalString(root))) {
      throw new Error(`kfdAgentHubEvidence.${label} must be a sha256 root`);
    }
  }
  if (value.verification?.valid !== true || value.verification?.contract !== "kungfu-buildchain-kfd-agent-hub-verification/v1") {
    throw new Error("kfdAgentHubEvidence.verification must bind a valid Buildchain Agent Hub verification");
  }
  if (value.kfd?.package?.name !== "@kungfu-tech/kfd" || !value.kfd?.package?.version) {
    throw new Error("kfdAgentHubEvidence must bind an exact @kungfu-tech/kfd package version");
  }
  if (value.kfd?.profile?.id !== "kfd-agent-hub-conformance" || value.kfd?.suite?.id !== "kfd-agent-hub-20") {
    throw new Error("kfdAgentHubEvidence must bind the KFD Agent Hub conformance profile and fixed suite");
  }
  const evidenceDigest = `sha256:${sha256Text(stableJson(value))}`;
  return {
    schemaVersion: 1,
    contract: KFD_AGENT_HUB_RELEASE_EVIDENCE_CONTRACT,
    evidenceContract: value.contract,
    evidenceDigest,
    reportDigest: value.report.digest,
    lockRoot: value.lock.root,
    sourceCut: value.kfd,
    scope: value.scope,
    qualifying: false,
    certification: false,
    claimBoundary: optionalString(value.claimBoundary),
  };
}

function normalizePlatformArtifactManifest(meta, index = 0) {
  const normalized = normalizeEvidenceDocument(meta, `platformArtifactManifests[${index}]`);
  if (!normalized) {
    return undefined;
  }
  const fields = normalized.fields || {};
  return {
    ...normalized,
    platform: optionalString(fields.platform?.id || fields.platformId || fields.platform || ""),
    artifactName: optionalString(fields.artifactName || fields.links?.artifactName || ""),
  };
}

function normalizePublishArtifact(artifact = {}, index = 0) {
  const name = nonEmptyString(artifact.name, `publishEvidence.artifacts[${index}].name`);
  const normalized = {
    group: optionalString(artifact.group),
    kind: optionalString(artifact.kind),
    name,
    ref: optionalString(artifact.ref || artifact.version),
    digest: optionalString(artifact.digest || artifact.sha256 || artifact.integrity || artifact.shasum),
    evidence: optionalString(artifact.evidence),
  };
  for (const key of [
    "action",
    "platform",
    "contract_major",
    "parent_digest",
    "content",
    "release",
    "verification",
  ]) {
    if (Object.prototype.hasOwnProperty.call(artifact, key)) {
      normalized[key] = structuredClone(artifact[key]);
    }
  }
  return normalized;
}

function normalizePublishEvidence(value = undefined) {
  if (!value) {
    return undefined;
  }
  return {
    schema: Number(value.schema || value.schemaVersion || 1),
    version: optionalString(value.version),
    channel: optionalString(value.channel),
    sourceSha: optionalString(value.source_sha || value.sourceSha),
    releaseSha: optionalString(value.release_sha || value.releaseSha),
    targetRef: optionalString(value.target_ref || value.targetRef),
    releaseMaterialSha: optionalString(value.release_material_sha || value.releaseMaterialSha),
    publishToolingSha: optionalString(value.publish_tooling_sha || value.publishToolingSha),
    artifacts: Array.isArray(value.artifacts)
      ? value.artifacts.map((artifact, index) => normalizePublishArtifact(artifact, index))
      : [],
  };
}

function normalizeSurfaceImpact(entry = {}, index = 0) {
  const id = nonEmptyString(entry.id || entry.surface || entry.surfaceId, `surfaceImpacts[${index}].id`);
  const impact = normalizeImpactLevel(entry.impact || entry.classification || entry.versionImpact);
  return {
    id,
    impact,
    class: optionalString(entry.class || entry.changeClass || entry.change_class),
    rationale: optionalString(entry.rationale || entry.reason),
    source: optionalString(entry.source),
  };
}

function normalizeImpactLedger(value = undefined, { tag = "", line = "", decision = "unknown" } = {}) {
  if (!value) {
    return defaultImpact({ tag, line, decision });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("impact must be a JSON object");
  }
  const surfaceImpacts = Array.isArray(value.surfaceImpacts)
    ? value.surfaceImpacts.map((entry, index) => normalizeSurfaceImpact(entry, index))
    : [];
  const finalImpact = normalizeImpactLevel(
    value.versionImpact?.final ||
    value.versionImpact ||
    value.classification ||
    decision,
  );
  return {
    ...value,
    schemaVersion: Number(value.schemaVersion || 1),
    contract: value.contract || IMPACT_LEDGER_CONTRACT,
    release: {
      tag: optionalString(value.release?.tag || tag),
      line: optionalString(value.release?.line || line),
      ...(value.release && typeof value.release === "object" && !Array.isArray(value.release) ? value.release : {}),
    },
    versionImpact: {
      final: finalImpact,
      source: optionalString(value.versionImpact?.source || value.impactSource || "declared"),
      rationale: optionalString(value.versionImpact?.rationale || value.rationale || value.summary),
    },
    surfaceImpacts,
    classification: normalizeImpactLevel(value.classification || finalImpact),
    breaking: value.breaking === undefined ? finalImpact === "major" : Boolean(value.breaking),
    migrationRequired: value.migrationRequired === undefined ? finalImpact === "major" : Boolean(value.migrationRequired),
  };
}

function packageSetEntries(packageSet = undefined) {
  if (!packageSet) {
    return [];
  }
  return [
    ...(packageSet.main?.name ? [{ role: "main", ...packageSet.main }] : []),
    ...((packageSet.platforms || []).map((entry) => ({ role: "platform", ...entry }))),
  ];
}

function normalizePublishSummary({ packageSet = undefined, publishEvidence = undefined, publish = {} } = {}) {
  const packages = packageSetEntries(packageSet);
  if (packages.length === 0) {
    return undefined;
  }
  const artifacts = publishEvidence?.artifacts || [];
  const artifactByPackage = new Map(artifacts.map((artifact) => [
    [artifact.name, artifact.ref || artifact.version || ""].join("\0"),
    artifact,
  ]));
  const normalizedPackages = packages.map((entry) => {
    const artifact = artifactByPackage.get([entry.name, entry.version].join("\0")) || {};
    return {
      role: entry.role,
      name: entry.name,
      publishedVersion: entry.version,
      distTag: entry.distTag,
      digest: entry.digest || artifact.digest || "",
      registry: entry.registry || packageSet.registry || publish.registry || "",
      platform: entry.platform || "",
      action: entry.action || artifact.action || "",
    };
  });
  const distTags = [...new Set(normalizedPackages.map((entry) => entry.distTag).filter(Boolean))];
  return {
    registry: optionalString(packageSet.registry || publish.registry),
    channel: optionalString(publishEvidence?.channel || publish.channel),
    distTag: distTags.length === 1 ? distTags[0] : "",
    source: "packageSet+publishEvidence",
    packages: normalizedPackages,
  };
}

function normalizeTrustedPublishing(value = undefined, { workflow = {}, publish = {} } = {}) {
  if (!value && publish.auth !== "trusted-publishing") {
    return undefined;
  }
  const raw = value || {};
  return {
    provider: optionalString(raw.provider || "npm"),
    enabled: raw.enabled === undefined ? publish.auth === "trusted-publishing" : Boolean(raw.enabled),
    auth: optionalString(raw.auth || publish.auth),
    workflowRunId: optionalString(raw.workflowRunId || raw.workflow_run_id || workflow.runId),
    workflowRunAttempt: optionalString(raw.workflowRunAttempt || raw.workflow_run_attempt || workflow.runAttempt),
    evidence: optionalString(raw.evidence),
  };
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function arrayOrSingleton(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return value && typeof value === "object" ? [value] : [];
}

function normalizeKfd2Claim(raw = {}, index = 0) {
  const claim = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const sourceBindings = arrayOrEmpty(claim.sourceBindings || claim.source_bindings || claim.sources || claim.declaredSources);
  const machineEvidence = arrayOrEmpty(claim.machineEvidence || claim.machine_evidence || claim.evidence);
  const hashes = claim.hashes && typeof claim.hashes === "object" && !Array.isArray(claim.hashes) ? claim.hashes : {};
  const artifacts = arrayOrEmpty(claim.artifacts || claim.artifactCoordinates || claim.artifact_coordinates);
  const verification = claim.verification && typeof claim.verification === "object" && !Array.isArray(claim.verification) ? claim.verification : {};
  const auditBoundary = claim.auditBoundary && typeof claim.auditBoundary === "object" && !Array.isArray(claim.auditBoundary)
    ? claim.auditBoundary
    : claim.audit_boundary && typeof claim.audit_boundary === "object" && !Array.isArray(claim.audit_boundary)
      ? claim.audit_boundary
      : {};
  const responsibility = claim.responsibility && typeof claim.responsibility === "object" && !Array.isArray(claim.responsibility) ? claim.responsibility : {};
  const residualRisk = arrayOrSingleton(claim.residualRisk || claim.residual_risk).map((entry, riskIndex) => validateKfd2TrustTaxonomyEntry(entry, {
    kind: "residualRisk",
    label: `kfd-2.claims[${index}].residualRisk[${riskIndex}]`,
  }));
  const downgradeReasons = arrayOrSingleton(claim.downgradeReasons || claim.downgrade_reasons || claim.downgradeReason || claim.downgrade_reason)
    .map((entry, reasonIndex) => validateKfd2TrustTaxonomyEntry(entry, {
      kind: "downgradeReason",
      label: `kfd-2.claims[${index}].downgradeReasons[${reasonIndex}]`,
    }));
  const trustProof = claim.trustProof && typeof claim.trustProof === "object" && !Array.isArray(claim.trustProof)
    ? claim.trustProof
    : undefined;
  const missingBindings = [];
  if (sourceBindings.length === 0) missingBindings.push("declared-sources");
  if (machineEvidence.length === 0) missingBindings.push("machine-readable-evidence");
  if (Object.keys(hashes).length === 0) missingBindings.push("hashes");
  if (artifacts.length === 0) missingBindings.push("artifact-coordinates");
  if (!verification.result && !verification.status) missingBindings.push("verification-result");
  if (Object.keys(auditBoundary).length === 0) missingBindings.push("audit-boundary");
  if (!responsibility.owner && !responsibility.sourceOwner && !responsibility.sourceContractOwner && !responsibility.releasePassportProofOwner) {
    missingBindings.push("responsibility-state");
  }
  if (!Array.isArray(claim.residualRisk || claim.residual_risk)) missingBindings.push("residual-risk");
  const proseOnly = Boolean(claim.proseOnly || claim.prose_only || claim.support === "prose" || claim.supportLevel === "prose");
  const explicitStatus = optionalString(claim.status || claim.result);
  const status = explicitStatus || (missingBindings.length > 0 ? "failed" : (proseOnly || residualRisk.length > 0) ? "downgraded" : "passed");
  return {
    id: optionalString(claim.id || `claim-${index + 1}`),
    public: claim.public === undefined ? true : Boolean(claim.public),
    claim: optionalString(claim.claim || claim.statement || claim.summary),
    sourceBindings,
    machineEvidence,
    hashes,
    artifacts,
    verification,
    auditBoundary,
    responsibility,
    residualRisk,
    downgradeReasons,
    ...(trustProof ? { trustProof } : {}),
    proseOnly,
    missingBindings,
    status,
  };
}

function kfd2ClaimFromKfd1World(world = {}, index = 0) {
  const sourceSurfaces = arrayOrEmpty(world.sourceVerification?.surfaces);
  const artifactSurfaces = arrayOrEmpty(world.artifactVerification?.surfaces);
  return normalizeKfd2Claim({
    id: `kfd-1:${world.id || index + 1}`,
    public: true,
    claim: `KFD-1 contract world ${world.id || index + 1} is verified from declared source surfaces to packaged artifact bytes.`,
    sourceBindings: sourceSurfaces.map((surface) => ({
      id: surface.name,
      path: surface.sourcePath,
      sha256: surface.actualSha256 || surface.expectedSha256,
    })),
    machineEvidence: [
      { id: "kfd-1-witness", sha256: world.preBuildWitnessSha256 },
      { id: "source-verification", status: world.sourceVerification?.status || "" },
      { id: "artifact-verification", status: world.artifactVerification?.status || "" },
    ],
    hashes: {
      witnessSha256: world.preBuildWitnessSha256,
      sourceSha256: world.sourceHashes?.sha256 || "",
      artifactSha256: world.artifactHashes?.sha256 || "",
    },
    artifacts: artifactSurfaces.map((surface) => ({
      id: surface.name,
      path: surface.artifactPath,
      sha256: surface.actualSha256,
    })),
    verification: {
      result: world.result === "passed" ? "passed" : "failed",
      source: world.sourceVerification?.status || "",
      artifact: world.artifactVerification?.status || "",
    },
    auditBoundary: world.selfHostingBoundary,
    responsibility: world.responsibility,
    residualRisk: world.selfHostingBoundary?.residualRisk || [],
  }, index);
}

function kfd2ClaimFromKfd3Interface(entry = {}, index = 0) {
  const witnessHashes = {
    prebuildWitnessSha256: entry.preBuildWitnessSha256,
    artifactWitnessSha256: entry.artifactWitnessSha256,
    prebuildCanonicalSha256: entry.witnessEvidence?.prebuild?.canonicalSha256 || "",
    artifactCanonicalSha256: entry.witnessEvidence?.artifact?.canonicalSha256 || "",
  };
  const reverseAuditBoundary = entry.reverseAudit?.auditBoundary || entry.auditBoundary;
  const residualRisk = arrayOrEmpty(entry.residualRisk);
  const proofResult = entry.trustProof?.result === "pass"
    ? (residualRisk.length > 0 ? "downgraded" : "passed")
    : "failed";
  return normalizeKfd2Claim({
    id: `kfd-3:${entry.id || index + 1}`,
    public: true,
    claim: `KFD-3 collaboration interface ${entry.id || index + 1} exposes only declared public participant-facing shipped surfaces within its audit boundary.`,
    sourceBindings: arrayOrEmpty(entry.declaredSurfaces).map((surface) => ({
      id: surface.id,
      kind: surface.kind,
      sourcePath: surface.sourcePath,
    })),
    machineEvidence: [
      { id: "prebuild-witness", ...entry.witnessEvidence?.prebuild },
      { id: "artifact-witness", ...entry.witnessEvidence?.artifact },
      { id: "declared-capability-verification", result: entry.declaredCapabilityVerification?.result || "" },
      { id: "reverse-audit", result: entry.reverseAudit?.status || "" },
    ],
    hashes: {
      ...witnessHashes,
    },
    artifacts: entry.artifactWitness?.artifact?.name || entry.artifactWitness?.artifact?.path
      ? [entry.artifactWitness.artifact]
      : arrayOrEmpty(entry.exposedSurfaces).map((surface) => ({ id: surface.id, kind: surface.kind })),
    verification: {
      result: entry.comparison?.status === "passed" ? "passed" : "failed",
      declaredCapabilityVerification: entry.declaredCapabilityVerification?.result || "",
      reverseAudit: entry.reverseAudit?.status || "",
    },
    auditBoundary: entry.auditBoundary,
    responsibility: entry.responsibility,
    residualRisk,
    trustProof: {
      contract: KFD2_TRUST_PROOF_CONTRACT,
      source: "kfd-3-collaboration-interface-release-gate",
      result: proofResult,
      statement: entry.trustProof?.statement || "",
      kfd3TrustProof: {
        contract: entry.trustProof?.contract || "",
        result: entry.trustProof?.result || "",
        releaseStatus: entry.trustProof?.releaseStatus || entry.releaseStatus || "",
      },
      witnessHashes,
      declaredCapabilityVerification: entry.declaredCapabilityVerification,
      reverseAudit: entry.reverseAudit,
      reverseAuditBoundary,
      residualRisk,
      responsibility: entry.responsibility,
    },
    status: proofResult,
  }, index);
}

function createKfd2ReleaseTrustPassportAudit({ explicitClaims = [], kfd1Section = undefined, kfd3Section = undefined, verifiedAt = nowIso() } = {}) {
  const generatedClaims = [
    ...arrayOrEmpty(kfd1Section?.contractWorlds).map((world, index) => kfd2ClaimFromKfd1World(world, index)),
    ...arrayOrEmpty(kfd3Section?.collaborationInterfaces).map((entry, index) => kfd2ClaimFromKfd3Interface(entry, index)),
  ];
  const claims = [
    ...generatedClaims,
    ...explicitClaims.map((claim, index) => normalizeKfd2Claim(claim, generatedClaims.length + index)),
  ];
  if (claims.length === 0) {
    return undefined;
  }
  const failed = claims.filter((claim) => claim.public && claim.status === "failed");
  const downgraded = claims.filter((claim) => claim.public && (claim.status === "downgraded" || claim.proseOnly));
  const downgradeReasons = claims.flatMap((claim) => arrayOrEmpty(claim.downgradeReasons));
  return {
    schemaVersion: 1,
    contract: KFD2_RELEASE_TRUST_PASSPORT_CONTRACT,
    status: failed.length > 0 ? "failed" : downgraded.length > 0 ? "downgraded" : "passed",
    verifiedAt,
    auditBoundary: {
      scope: "public release claims visible to humans or agents",
      policy: "public claims must bind declared sources, machine-readable evidence, hashes, artifact coordinates, verification results, audit boundaries, responsibility state, and residual risk",
    },
    downgradeReasons,
    claims,
    summary: {
      claimCount: claims.length,
      failed: failed.length,
      downgraded: downgraded.length,
      proseOnly: claims.filter((claim) => claim.proseOnly).length,
    },
  };
}

function normalizeTransactionResult(value = {}) {
  const result = {};
  if (value.command) {
    result.command = optionalString(value.command);
  }
  if (value.validation && typeof value.validation === "object" && !Array.isArray(value.validation)) {
    result.validation = {
      valid: Boolean(value.validation.valid),
      errors: Array.isArray(value.validation.errors) ? value.validation.errors : [],
    };
  }
  if (value.recovery && typeof value.recovery === "object" && !Array.isArray(value.recovery)) {
    result.recovery = value.recovery;
  }
  if (value.publishAction || value.distTag) {
    result.publish = {
      action: optionalString(value.publishAction),
      distTag: optionalString(value.distTag),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeTransaction(value = undefined) {
  if (!value) {
    return undefined;
  }
  const raw = value.transaction && typeof value.transaction === "object" ? value.transaction : value;
  return {
    id: optionalString(raw.id || value.id),
    version: optionalString(raw.version || value.version),
    state: optionalString(raw.state || value.state),
    previousState: optionalString(raw.previous_state || raw.previousState),
    exactTag: optionalString(raw.exact_tag || raw.exactTag || value.exactTag),
    releaseSha: optionalString(raw.release_sha || raw.releaseSha || value.releaseSha),
    releaseMaterialSha: optionalString(raw.release_material_sha || raw.releaseMaterialSha || value.releaseMaterialSha),
    stateRef: optionalString(raw.state_ref || raw.stateRef || value.stateRef),
    statePath: optionalString(raw.state_path || raw.statePath || value.statePath),
    stateSha: optionalString(value.stateSha || value.state_sha || value.durable?.sha),
    evidencePath: optionalString(raw.evidence_path || raw.evidencePath || value.evidencePath),
    updatedAt: optionalString(raw.updated_at || raw.updatedAt),
    result: normalizeTransactionResult(value),
  };
}

function normalizePromotionRouting(value = undefined) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release.promotionRouting must be a JSON object");
  }
  if (value.contract !== "buildchain.promotion-routing/v1") {
    throw new Error("release.promotionRouting contract must be buildchain.promotion-routing/v1");
  }
  for (const [label, field] of [
    ["router.ref", value.router?.ref],
    ["router.sha", value.router?.sha],
    ["shell.ref", value.shell?.ref],
    ["shell.sha", value.shell?.sha],
    ["runtime.requestedRef", value.runtime?.requestedRef],
    ["runtime.resolvedSha", value.runtime?.resolvedSha],
    ["contractLock.path", value.contractLock?.path],
    ["contractLock.digest", value.contractLock?.digest],
    ["publication.channel", value.publication?.channel],
    ["publication.targetRef", value.publication?.targetRef],
  ]) {
    if (!String(field || "").trim()) throw new Error(`release.promotionRouting.${label} is required`);
  }
  for (const [label, sha] of [
    ["router.sha", value.router.sha],
    ["shell.sha", value.shell.sha],
    ["runtime.resolvedSha", value.runtime.resolvedSha],
  ]) {
    if (!/^[0-9a-f]{40}$/i.test(String(sha))) {
      throw new Error(`release.promotionRouting.${label} must be a 40-character Git SHA`);
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(value.contractLock.digest))) {
    throw new Error("release.promotionRouting.contractLock.digest must be a sha256 digest");
  }
  return JSON.parse(JSON.stringify(value));
}

export function createArtifactEvidence({ assets = [], repository = "", tag = "", sourceSha = "", workflow = {}, kfdAdopter = undefined } = {}) {
  const normalizedAssets = assets.map((asset, index) => normalizeAsset(asset, index));
  return buildReleaseArtifactEvidence({ normalizedAssets, repository, tag, sourceSha, workflow, kfdAdopter });
}

function firstTruthy(...values) {
  for (const value of values) {
    if (value) return value;
  }
  return values.at(-1);
}

function releaseField(release, camelKey, snakeKey, ...fallbacks) {
  return optionalString(firstTruthy(release[camelKey], release[snakeKey], ...fallbacks));
}

function optionalSections(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value && (!Array.isArray(value) || value.length > 0)));
}

function acceptedControllerSourceShas(input) {
  const { treeEquivalent, builtSourceSha, promotionChannelSha, sourceSha, recoveryTreeEquivalent } = input;
  return treeEquivalent && builtSourceSha && (promotionChannelSha === sourceSha || recoveryTreeEquivalent)
    ? [builtSourceSha]
    : [];
}

function prepareReleaseKfdAdopterArtifacts({ kfdAdopter, assets, repository, tag, sourceSha, workflow }) {
  const normalized = kfdAdopter ? structuredClone(kfdAdopter) : undefined;
  return {
    normalized,
    artifactEvidence: createArtifactEvidence({ assets, repository, tag, sourceSha, workflow, kfdAdopter: normalized }),
  };
}

export function createReleasePassport({
  cwd = process.cwd(),
  repository = "",
  tag = "",
  sourceSha = "",
  line = "",
  productName = "Buildchain",
  packageName = "@kungfu-tech/buildchain",
  packageVersion = "",
  productMechanismPath = "product-mechanism.json",
  artifactEvidencePath = "artifact-evidence.json",
  impactPath = "impact.json",
  agentIndexPath = "agent-index.json",
  checkReportPath = "check-report.json",
  publishEvidencePath = "",
  transactionStatePath = "",
  assets = [],
  packageSet = undefined,
  anchorManifest = undefined,
  versionMaterial = undefined,
  publishEvidence = undefined,
  trustedPublishing = undefined,
  transaction = undefined,
  buildSummary = undefined,
  buildFacts = [],
  platformArtifactManifests = [],
  distTagPromotionEvidence = undefined,
  release = {},
  publish = {},
  impact = undefined,
  workflow = {},
  kfd1 = undefined,
  kfd2Claims = [],
  kfd3 = undefined,
  kfdAdopter = undefined,
  kfdAdopterManifestEvidencePath = "",
  kfdAdopterGateEvidencePath = "",
  kfdSupport = undefined,
  kfdSupportEvidencePath = "",
  invariantPassports = undefined,
  releaseEvidence = [],
  kfdAgentHubEvidence = undefined,
  kfdAgentHubEvidencePath = "",
  controllerReceipts = [],
  controllerReceiptReferences = [],
  githubArtifactAttestations = [],
  checkedAt = "",
} = {}) {
  const normalizedTag = nonEmptyString(tag, "tag");
  const { normalized: normalizedKfdAdopter, artifactEvidence } = prepareReleaseKfdAdopterArtifacts({
    kfdAdopter, assets, repository, tag: normalizedTag, sourceSha, workflow,
  });
  const normalizedPublishEvidence = normalizePublishEvidence(publishEvidence);
  const normalizedPackageSet = normalizePackageSet(packageSet, { packageName, packageVersion, publish });
  const normalizedTrustedPublishing = normalizeTrustedPublishing(trustedPublishing, { workflow, publish });
  const normalizedTransaction = normalizeTransaction(transaction);
  const normalizedPromotionRouting = normalizePromotionRouting(release.promotionRouting);
  const normalizedBuildSummary = buildSummary ? normalizeEvidenceDocument(buildSummary, "buildSummary") : undefined;
  const normalizedBuildFacts = (buildFacts || [])
    .map((fact, index) => normalizeEvidenceDocument(fact, `buildFacts[${index}]`))
    .filter(Boolean);
  const normalizedPlatformArtifactManifests = (platformArtifactManifests || [])
    .map((manifest, index) => normalizePlatformArtifactManifest(manifest, index))
    .filter(Boolean);
  const normalizedDistTagPromotionEvidence = distTagPromotionEvidence
    ? normalizeEvidenceDocument(distTagPromotionEvidence, "distTagPromotionEvidence")
    : undefined;
  const normalizedImpact = normalizeImpactLedger(impact, { tag: normalizedTag, line });
  const generatedAt = optionalString(checkedAt) || nowIso();
  const kfd1Metadata = resolveKfd1Metadata();
  const normalizedKfdAgentHub = normalizeKfdAgentHubEvidence(kfdAgentHubEvidence);
  const kfdParts = prepareReleasePassportKfdSections({
    kfd1,
    kfd2Claims,
    kfd3,
    kfdAdopter: normalizedKfdAdopter,
    kfdSupport,
    kfd1DefaultKey: kfd1Metadata.key,
    createKfd2: createKfd2ReleaseTrustPassportAudit,
    evidencePaths: {
      manifest: kfdAdopterManifestEvidencePath,
      gate: kfdAdopterGateEvidencePath,
      support: kfdSupportEvidencePath,
    },
  });
  const builtSourceSha = releaseField(release, "builtSourceSha", "built_source_sha");
  const builtSourceTreeSha = releaseField(release, "builtSourceTreeSha", "built_source_tree_sha");
  const promotionChannelSha = releaseField(release, "promotionChannelSha", "promotion_channel_sha");
  const promotionChannelTreeSha = releaseField(release, "promotionChannelTreeSha", "promotion_channel_tree_sha");
  const treeEquivalent = release.treeEquivalent === true;
  const recoveryTreeEquivalent = Boolean(
    treeEquivalent &&
    builtSourceTreeSha &&
    promotionChannelTreeSha &&
    builtSourceTreeSha === promotionChannelTreeSha,
  );
  const normalizedControllerReceipts = normalizeControllerReceiptReferences({
    receipts: controllerReceipts,
    references: controllerReceiptReferences,
    expectedSourceSha: sourceSha,
    acceptedSourceShas: acceptedControllerSourceShas({
      treeEquivalent,
      builtSourceSha,
      promotionChannelSha,
      sourceSha,
      recoveryTreeEquivalent,
    }),
    requirePassed: true,
  });
  const normalizedGitHubArtifactAttestations = (githubArtifactAttestations || [])
    .map(normalizeGitHubArtifactAttestationPolicy);
  const publishArtifacts = normalizedPublishEvidence?.artifacts || [];
  const normalizedPublishSummary = normalizePublishSummary({
    packageSet: normalizedPackageSet,
    publishEvidence: normalizedPublishEvidence,
    publish,
  });
  const releaseMaterialSha = releaseField(release, "releaseMaterialSha", "release_material_sha", normalizedPublishEvidence?.releaseMaterialSha, normalizedTransaction?.releaseMaterialSha);
  const releaseSha = releaseField(release, "releaseSha", "release_sha", normalizedPublishEvidence?.releaseSha, normalizedTransaction?.releaseSha);
  const targetRef = releaseField(release, "targetRef", "target_ref", normalizedPublishEvidence?.targetRef);
  const mainPublishedVersion = normalizedPublishSummary?.packages?.find((entry) => entry.role === "main")?.publishedVersion;
  const packageDisplayVersion = optionalString(firstTruthy(packageVersion, normalizedPackageSet?.main?.version, mainPublishedVersion, normalizedPublishEvidence?.version, normalizedTransaction?.version, readPackageVersion(cwd)));
  const publishedVersion = releaseField(release, "publishedVersion", "published_version", packageDisplayVersion);
  const internalVersion = releaseField(release, "internalVersion", "internal_version", normalizedTransaction?.version);
  return {
    schemaVersion: 1,
    contract: RELEASE_PASSPORT_CONTRACT,
    generatedAt,
    surfaceTimestampPolicy: createSurfaceTimestampPolicy({
      generatedAt,
      publishedAt: optionalString(release.publishedAt || release.published_at || normalizedPublishEvidence?.publishedAt),
      sourceRevision: optionalString(firstTruthy(sourceSha, releaseSha, normalizedTransaction?.releaseSha)),
      timestampPolicy: "ci-injected",
      deterministicInputs: [
        "release.sourceSha",
        "release.releaseSha",
        "release.releaseMaterialSha",
        "artifact-evidence.json",
        "publish evidence",
        "release-state transaction",
        "controller receipt references",
      ],
      timestampFields: ["generatedAt", "publishedAt", "surfaceTimestampPolicy.generatedAt", "surfaceTimestampPolicy.publishedAt"],
      timestampFieldsParticipateInArtifactDigest: true,
      artifactDigestScope: "release passport JSON and release evidence bundle",
    }),
    product: {
      name: optionalString(productName || "Buildchain"),
      repository: optionalString(repository),
      mechanism: productMechanismPath,
    },
    release: {
      tag: normalizedTag,
      publicTag: releaseField(release, "publicTag", "public_tag", normalizedTag),
      internalTag: releaseField(release, "internalTag", "internal_tag", normalizedTag),
      internalVersion,
      publishedVersion,
      versionLabel: releaseField(release, "versionLabel", "version_label", publishedVersion, normalizedTag),
      line: optionalString(line),
      sourceSha: optionalString(sourceSha),
      channel: optionalString(firstTruthy(release.channel, normalizedPublishEvidence?.channel, publish.channel)),
      targetRef,
      releaseSha,
      releaseMaterialSha,
      builtSourceSha: optionalString(release.builtSourceSha || release.built_source_sha),
      builtSourceTreeSha,
      promotionChannelSha: optionalString(release.promotionChannelSha || release.promotion_channel_sha),
      promotionChannelTreeSha,
      treeEquivalent: release.treeEquivalent === undefined ? undefined : Boolean(release.treeEquivalent),
      publishToolingSha: optionalString(
        release.publishToolingSha ||
        release.publish_tooling_sha ||
        normalizedPublishEvidence?.publishToolingSha,
      ),
      releaseStateRef: optionalString(
        release.releaseStateRef ||
        release.release_state_ref ||
        normalizedTransaction?.stateRef ||
        (normalizedTag ? `refs/heads/buildchain/release-state/${normalizedTag.replace(/^v/, "").replace(/[^0-9A-Za-z]+/g, "-")}` : ""),
      ),
      releaseStateSha: optionalString(release.releaseStateSha || release.release_state_sha || normalizedTransaction?.stateSha),
      package: {
        name: packageName,
        version: packageDisplayVersion,
      },
      exactRef: normalizedTag ? `refs/tags/${normalizedTag}` : "",
    },
    workflow: {
      name: optionalString(workflow.name),
      runId: optionalString(workflow.runId),
      runAttempt: optionalString(workflow.runAttempt),
      url: optionalString(workflow.url),
    },
    runnerPolicy: {
      productionDefault: "github-hosted",
      compatibilityFixture: "self-hosted",
      note: "Runner facts are recorded in artifact evidence; the protocol does not require self-hosted runners.",
    },
    ...optionalSections([
      ["packageSet", normalizedPackageSet],
      ["publish", normalizedPublishSummary],
      ["anchorManifest", anchorManifest],
      ["versionMaterial", versionMaterial],
      ["trustedPublishing", normalizedTrustedPublishing],
      ["transaction", normalizedTransaction],
      ["promotionRouting", normalizedPromotionRouting],
      ["buildSummary", normalizedBuildSummary],
      ["buildFacts", normalizedBuildFacts],
      ["platformArtifactManifests", normalizedPlatformArtifactManifests],
      ["distTagPromotion", normalizedDistTagPromotionEvidence],
      ...kfdParts.sectionEntries,
      ["kfdAgentHub", normalizedKfdAgentHub],
      ["invariantPassports", invariantPassports],
      ["releaseEvidence", releaseEvidence],
      ["controllerReceipts", normalizedControllerReceipts],
      ["githubArtifactAttestations", normalizedGitHubArtifactAttestations],
    ]),
    versionImpact: normalizedImpact.versionImpact,
    surfaceImpacts: normalizedImpact.surfaceImpacts,
    artifacts: [
      ...artifactEvidence.artifacts.map((asset) => ({
        group: "release",
        kind: asset.kind || "release-asset",
        name: asset.name,
        platform: asset.platform,
        ref: normalizedTag,
        sha256: asset.sha256,
        digest: asset.sha256 ? `sha256:${asset.sha256}` : "",
        evidence: artifactEvidencePath,
        url: asset.url,
      })),
      ...publishArtifacts.map((artifact) => ({
        ...artifact,
        evidence: publishEvidencePath || artifact.evidence || artifactEvidencePath,
      })),
    ],
    evidence: {
      artifactEvidence: artifactEvidencePath,
      publishEvidence: publishEvidencePath,
      transactionState: transactionStatePath,
      buildSummary: normalizedBuildSummary?.path || "",
      buildFacts: normalizedBuildFacts.map((fact) => ({
        path: fact.path || "",
        sha256: fact.sha256 || "",
        contract: fact.fields?.contract || "",
        id: fact.fields?.id || "",
        digest: fact.fields?.digest || "",
      })),
      platformArtifactManifests: normalizedPlatformArtifactManifests.map((manifest) => ({
        path: manifest.path,
        sha256: manifest.sha256,
        platform: manifest.platform,
        artifactName: manifest.artifactName,
      })),
      distTagPromotionEvidence: normalizedDistTagPromotionEvidence?.path || "",
      ...kfdParts.evidence,
      kfdAgentHub: normalizedKfdAgentHub ? optionalString(kfdAgentHubEvidencePath || "kfd-agent-hub-evidence.json") : "",
      invariantPassports: invariantPassports ? "invariantPassports" : "",
      releaseEvidence: releaseEvidence.map((entry) => entry.path),
      impact: impactPath,
      checkReport: checkReportPath,
      agentIndex: agentIndexPath,
    },
    recovery: {
      rollback: "Use the previous exact release tag or previous floating channel ref.",
      verify: `buildchain verify release-passport ${normalizedTag ? "buildchain.release.json" : "<passport>"}`,
    },
  };
}

function collectKfdAdopterReleaseInputs({ cwd, manifestJson, supportMatrixJson, productGateJsons, sourceSha, checkedAt }) {
  const manifestMeta = parseJsonInputWithMeta(manifestJson, undefined, { cwd, label: "kfdAdopterManifestJson" });
  const supportMatrixMeta = parseJsonInputWithMeta(supportMatrixJson, undefined, { cwd, label: "kfdSupportMatrixJson" });
  const productGateMetas = (productGateJsons || [])
    .filter(Boolean)
    .map((gateJson) => parseJsonInputWithMeta(gateJson, undefined, { cwd, label: "kfdProductGateJsons entry" }))
    .filter((meta) => meta.value);
  return collectKfdAdopterReleaseEvidence({
    manifest: manifestMeta.value,
    gateResults: productGateMetas.map((meta) => meta.value),
    comparisonMatrix: supportMatrixMeta.value,
    sourceSha,
    checkedAt,
  });
}

function copyReleaseEvidenceAttachments(attachments, outputDir) {
  const ids = new Set();
  for (const { reference } of attachments) {
    if (ids.has(reference.id)) {
      throw new Error(`release evidence attachment id must be unique: ${reference.id}`);
    }
    ids.add(reference.id);
  }
  for (const { inputPath, reference } of attachments) {
    const destinationPath = path.join(outputDir, reference.path);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(inputPath, destinationPath);
  }
}

export function collectGitHubReleasePassport({
  cwd = process.cwd(),
  tag = "",
  repository = process.env.GITHUB_REPOSITORY || "",
  sourceSha = process.env.GITHUB_SHA || "",
  line = "",
  outputDir = ".buildchain/release-passport",
  assetsJson = "",
  assetsDir = "",
  releaseJson = "",
  productName = "Buildchain",
  packageName = "@kungfu-tech/buildchain",
  packageVersion = "",
  packageSetJson = "",
  publishEvidenceJson = "",
  trustedPublishingJson = "",
  transactionJson = "",
  anchorManifestJson = "",
  versionMaterialJson = "",
  impactJson = "",
  buildSummaryJson = "",
  buildFactsJsons = [],
  platformManifestJsons = [],
  distTagEvidenceJson = "",
  kfd1WitnessJsons = [],
  kfd2ClaimJsons = [],
  kfd3PrebuildWitnessJsons = [],
  kfd3ArtifactWitnessJsons = [],
  kfd3ArtifactVerifyCommand = "",
  kfdAdopterManifestJson = "",
  kfdSupportMatrixJson = "",
  kfdProductGateJsons = [],
  invariantPassportJsons = [],
  invariantPassportCommand = "",
  releaseEvidenceJsons = [],
  kfdAgentHubEvidenceJson = "",
  controllerReceiptReferences = [],
  githubArtifactAttestationPolicyJsons = [],
  basePassportJson = "",
  requireBaseKfd = false,
  releaseJsonExtra = "",
  publishJson = "",
  workflow = {},
  checkedAt = "",
} = {}) {
  const release = parseJsonInput(releaseJson, {}, { cwd, label: "releaseJson" });
  const releaseExtra = parseJsonInput(releaseJsonExtra, {}, { cwd, label: "releaseJsonExtra" });
  const assetsFromJson = parseJsonInput(assetsJson, [], { cwd, label: "assetsJson" });
  const packageSet = parseJsonInput(packageSetJson, undefined, { cwd, label: "packageSetJson" });
  const publishEvidenceMeta = parseJsonInputWithMeta(publishEvidenceJson, undefined, { cwd, label: "publishEvidenceJson" });
  const trustedPublishing = parseJsonInput(trustedPublishingJson, undefined, { cwd, label: "trustedPublishingJson" });
  const transactionMeta = parseJsonInputWithMeta(transactionJson, undefined, { cwd, label: "transactionJson" });
  const anchorManifest = normalizeAnchorManifest(parseJsonInputWithMeta(anchorManifestJson, undefined, { cwd, label: "anchorManifestJson" }));
  const versionMaterial = parseJsonInput(
    versionMaterialJson,
    undefined,
    { cwd, label: "versionMaterialJson" },
  );
  const impactMeta = parseJsonInputWithMeta(impactJson, undefined, { cwd, label: "impactJson" });
  const buildSummaryMeta = parseJsonInputWithMeta(buildSummaryJson, undefined, { cwd, label: "buildSummaryJson" });
  const buildFactMetas = (buildFactsJsons || [])
    .filter(Boolean)
    .map((buildFactsJson) => parseJsonInputWithMeta(buildFactsJson, undefined, { cwd, label: "buildFactsJsons entry" }))
    .filter((meta) => meta.value);
  const platformManifestMetas = (platformManifestJsons || [])
    .filter(Boolean)
    .map((manifestJson) => parseJsonInputWithMeta(manifestJson, undefined, { cwd, label: "platformManifestJsons entry" }));
  const distTagEvidenceMeta = parseJsonInputWithMeta(distTagEvidenceJson, undefined, { cwd, label: "distTagEvidenceJson" });
  const kfd1WitnessMetas = (kfd1WitnessJsons || [])
    .filter(Boolean)
    .map((witnessJson) => parseJsonInputWithMeta(witnessJson, undefined, { cwd, label: "kfd1WitnessJsons entry" }))
    .filter((meta) => meta.value);
  const kfd2ClaimMetas = (kfd2ClaimJsons || [])
    .filter(Boolean)
    .map((claimJson) => parseJsonInputWithMeta(claimJson, undefined, { cwd, label: "kfd2ClaimJsons entry" }))
    .filter((meta) => meta.value);
  const kfd3PrebuildWitnessMetas = (kfd3PrebuildWitnessJsons || [])
    .filter(Boolean)
    .map((witnessJson) => parseJsonInputWithMeta(witnessJson, undefined, { cwd, label: "kfd3PrebuildWitnessJsons entry" }))
    .filter((meta) => meta.value);
  const kfd3ArtifactWitnessMetas = (kfd3ArtifactWitnessJsons || [])
    .filter(Boolean)
    .map((witnessJson) => parseJsonInputWithMeta(witnessJson, undefined, { cwd, label: "kfd3ArtifactWitnessJsons entry" }))
    .filter((meta) => meta.value);
  const basePassportMeta = parseJsonInputWithMeta(basePassportJson, undefined, { cwd, label: "basePassportJson" });
  const kfd3ArtifactCommandMeta = parseJsonCommandOutput({
    command: kfd3ArtifactVerifyCommand,
    cwd,
    label: "KFD-3 artifact verify command",
  });
  const invariantPassportMetas = (invariantPassportJsons || [])
    .filter(Boolean)
    .map((passportJson) => parseJsonInputWithMeta(passportJson, undefined, { cwd, label: "invariantPassportJsons entry" }))
    .filter((meta) => meta.value);
  const invariantPassportCommandMeta = parseJsonCommandOutput({
    command: invariantPassportCommand,
    cwd,
    label: "invariant passport command",
  });
  if (invariantPassportCommandMeta.value) invariantPassportMetas.push(invariantPassportCommandMeta);
  const invariantPassports = createInvariantPassportGate(invariantPassportMetas);
  const releaseEvidenceMetas = (releaseEvidenceJsons || [])
    .filter(Boolean)
    .map((evidenceJson) =>
      parseJsonInputWithMeta(evidenceJson, undefined, {
        cwd,
        label: "releaseEvidenceJsons entry",
      }),
    )
    .filter((meta) => meta.value);
  const kfdAgentHubEvidenceMeta = parseJsonInputWithMeta(
    kfdAgentHubEvidenceJson,
    undefined,
    { cwd, label: "kfdAgentHubEvidenceJson" },
  );
  const githubArtifactAttestationPolicies = (githubArtifactAttestationPolicyJsons || [])
    .filter(Boolean)
    .map((policyJson) => parseJsonInput(policyJson, undefined, {
      cwd,
      label: "githubArtifactAttestationPolicyJsons entry",
    }))
    .map(normalizeGitHubArtifactAttestationPolicy);
  const kfd3ArtifactWitnesses = [
    ...kfd3ArtifactWitnessMetas.map((meta) => meta.value),
    ...(kfd3ArtifactCommandMeta.value ? [kfd3ArtifactCommandMeta.value] : []),
  ];
  const publish = parseJsonInput(publishJson, {}, { cwd, label: "publishJson" });
  const assets = [
    ...(Array.isArray(release.assets) ? release.assets : []),
    ...(Array.isArray(assetsFromJson) ? assetsFromJson : []),
    ...discoverAssetsFromDir(assetsDir ? path.resolve(cwd, assetsDir) : ""),
  ];
  const resolvedTag = tag || release.tag_name || release.name || "";
  const resolvedOutputDir = path.resolve(cwd, outputDir);
  const resolvedChannel = optionalString(releaseExtra.channel || publish.channel);
  const releaseEvidenceAttachments = releaseEvidenceMetas.map((meta, index) =>
    normalizeReleaseEvidenceAttachment(meta, {
      cwd,
      expectedSourceSha: sourceSha,
      expectedTag: resolvedTag,
      expectedChannel: resolvedChannel,
      index,
    }),
  );
  copyReleaseEvidenceAttachments(releaseEvidenceAttachments, resolvedOutputDir);
  const resolvedCheckedAt = optionalString(checkedAt) || nowIso();
  const productMechanism = defaultProductMechanism({ repository, productName });
  const kfdAdopterEvidence = collectKfdAdopterReleaseInputs({
    cwd, manifestJson: kfdAdopterManifestJson, supportMatrixJson: kfdSupportMatrixJson,
    productGateJsons: kfdProductGateJsons, sourceSha, checkedAt: resolvedCheckedAt,
  });
  const {
    manifest: kfdAdopterManifest,
    manifestGate: kfdAdopterManifestGate,
    legacyProjection: kfdSupport,
    binding: kfdAdopter,
  } = kfdAdopterEvidence;
  const artifactEvidence = createArtifactEvidence({
    assets,
    repository,
    tag: resolvedTag,
    sourceSha,
    workflow,
    kfdAdopter,
  });
  const bundledPublishEvidencePath = publishEvidenceMeta.value ? "evidence.json" : "";
  const impact = mergeAuthoritativeImpactBase(
    normalizeImpactLedger(impactMeta.value, { tag: resolvedTag, line, decision: "unknown" }),
    basePassportMeta.value,
  );
  const agentIndex = defaultAgentIndex({ tag: resolvedTag });
  const kfd1 = createKfd1ReleaseGateEvidence({
    cwd,
    artifactRoot: assetsDir ? path.resolve(cwd, assetsDir) : "",
    artifacts: assets,
    witnesses: kfd1WitnessMetas.map((meta) => meta.value),
  });
  const kfd3 = createKfd3CollaborationInterfaceReleaseGateEvidence({
    prebuildWitnesses: kfd3PrebuildWitnessMetas.map((meta) => meta.value),
    artifactWitnesses: kfd3ArtifactWitnesses,
    prebuildWitnessMetas: kfd3PrebuildWitnessMetas,
    artifactWitnessMetas: kfd3ArtifactWitnessMetas,
    artifactCommandMeta: kfd3ArtifactCommandMeta.value ? kfd3ArtifactCommandMeta : undefined,
  });
  const passport = mergeAuthoritativePassportBase(createReleasePassport({
    cwd,
    repository,
    tag: resolvedTag,
    sourceSha,
    line,
    productName,
    packageName,
    packageVersion,
    assets,
    packageSet,
    anchorManifest,
    versionMaterial,
    publishEvidence: publishEvidenceMeta.value,
    trustedPublishing,
    transaction: transactionMeta.value,
    buildSummary: buildSummaryMeta.value
      ? {
          ...buildSummaryMeta,
          path: buildSummaryMeta.path ? path.relative(resolvedOutputDir, buildSummaryMeta.path).split(path.sep).join("/") : "",
        }
      : undefined,
    buildFacts: buildFactMetas.map((meta) => ({
      ...meta,
      path: meta.path ? path.relative(resolvedOutputDir, meta.path).split(path.sep).join("/") : "",
    })),
    platformArtifactManifests: platformManifestMetas
      .filter((meta) => meta.value)
      .map((meta) => ({
        ...meta,
        path: meta.path ? path.relative(resolvedOutputDir, meta.path).split(path.sep).join("/") : "",
      })),
    distTagPromotionEvidence: distTagEvidenceMeta.value
      ? {
          ...distTagEvidenceMeta,
          path: distTagEvidenceMeta.path ? path.relative(resolvedOutputDir, distTagEvidenceMeta.path).split(path.sep).join("/") : "",
        }
      : undefined,
    release: releaseExtra,
    publish,
    impact,
    kfd1,
    kfd2Claims: kfd2ClaimMetas.map((meta) => meta.value),
    kfd3,
    kfdAdopter,
    kfdAdopterManifestEvidencePath: kfdAdopter ? "kfd-adopter-manifest.json" : "",
    kfdAdopterGateEvidencePath: kfdAdopter ? "kfd-adopter-manifest-gate.json" : "",
    kfdSupport,
    kfdSupportEvidencePath: kfdSupport ? "kfd-support.json" : "",
    invariantPassports,
    releaseEvidence: releaseEvidenceAttachments.map(({ reference }) => reference),
    kfdAgentHubEvidence: kfdAgentHubEvidenceMeta.value
      ? { ...kfdAgentHubEvidenceMeta, path: "kfd-agent-hub-evidence.json" }
      : undefined,
    kfdAgentHubEvidencePath: kfdAgentHubEvidenceMeta.value ? "kfd-agent-hub-evidence.json" : "",
    controllerReceiptReferences,
    githubArtifactAttestations: githubArtifactAttestationPolicies,
    publishEvidencePath: publishEvidenceMeta.path ? path.relative(resolvedOutputDir, publishEvidenceMeta.path).split(path.sep).join("/") : "",
    transactionStatePath: transactionMeta.path ? path.relative(resolvedOutputDir, transactionMeta.path).split(path.sep).join("/") : "",
    workflow,
    checkedAt: resolvedCheckedAt,
  }), basePassportMeta.value, { requireKfd: requireBaseKfd });
  if (bundledPublishEvidencePath) {
    passport.evidence.publishEvidence = bundledPublishEvidencePath;
  }
  const checkReport = createReleaseCheckReport({
    passport,
    artifactEvidence,
    publishEvidence: publishEvidenceMeta.value,
    impact,
    agentIndex,
    productMechanism,
    kfdAgentHubEvidence: kfdAgentHubEvidenceMeta.value,
    kfdSupportEvidence: kfdSupport,
    kfdAdopterManifest,
    kfdAdopterManifestGate,
    releaseEvidenceDocuments: releaseEvidenceAttachments,
    checkedAt: resolvedCheckedAt,
  });
  const files = {
    "product-mechanism.json": productMechanism,
    "artifact-evidence.json": artifactEvidence,
    ...(publishEvidenceMeta.value ? { [bundledPublishEvidencePath]: publishEvidenceMeta.value } : {}),
    "impact.json": impact,
    "agent-index.json": agentIndex,
    ...(kfdAgentHubEvidenceMeta.value ? { "kfd-agent-hub-evidence.json": kfdAgentHubEvidenceMeta.value } : {}),
    ...(kfdAdopterManifest ? { "kfd-adopter-manifest.json": kfdAdopterManifest } : {}),
    ...(kfdAdopterManifestGate ? { "kfd-adopter-manifest-gate.json": kfdAdopterManifestGate } : {}),
    ...(kfdSupport ? { "kfd-support.json": kfdSupport } : {}),
    "buildchain.release.json": passport,
    "check-report.json": checkReport,
  };
  for (const [fileName, value] of Object.entries(files)) {
    writeJsonFile(path.join(resolvedOutputDir, fileName), value);
  }
  writeTextFile(path.join(resolvedOutputDir, "llms.txt"), defaultLlmsText({ tag: resolvedTag }));
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-passport-collection",
    outputDir: resolvedOutputDir,
    files: Object.keys(files)
      .concat(releaseEvidenceAttachments.map(({ reference }) => reference.path))
      .concat("llms.txt"),
    passport,
    artifactEvidence,
    checkReport,
  };
}

function issue(level, code, message, details = {}) {
  return { level, code, message, details };
}

function validateContract(value, expectedContract, label, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(issue("error", `${label}.object`, `${label} must be a JSON object`));
    return;
  }
  if (Number(value.schemaVersion) !== 1) {
    issues.push(issue("error", `${label}.schemaVersion`, `${label}.schemaVersion must be 1`));
  }
  if (value.contract !== expectedContract) {
    issues.push(issue("error", `${label}.contract`, `${label}.contract must be ${expectedContract}`));
  }
}

function validateKfd2ReleaseTrustPassportAudit(section, issues) {
  if (!section) {
    return;
  }
  if (typeof section !== "object" || Array.isArray(section)) {
    issues.push(issue("error", "kfd-2.object", "kfd-2 release trust passport audit must be a JSON object"));
    return;
  }
  if (section.contract !== KFD2_RELEASE_TRUST_PASSPORT_CONTRACT) {
    issues.push(issue("error", "kfd-2.contract", `kfd-2 contract must be ${KFD2_RELEASE_TRUST_PASSPORT_CONTRACT}`));
  }
  const claims = Array.isArray(section.claims) ? section.claims : [];
  if (claims.length === 0) {
    issues.push(issue("error", "kfd-2.claims.empty", "kfd-2 audit must enumerate at least one public release claim"));
  }
  for (const [reasonIndex, reason] of arrayOrEmpty(section.downgradeReasons).entries()) {
    try {
      validateKfd2TrustTaxonomyEntry(reason, {
        kind: "downgradeReason",
        label: `kfd-2.downgradeReasons[${reasonIndex}]`,
      });
    } catch (error) {
      issues.push(issue("error", `kfd-2.downgradeReasons[${reasonIndex}]`, error.message, {
        id: reason?.id || "",
      }));
    }
  }
  for (const [index, claim] of claims.entries()) {
    if (!claim.id || !claim.claim) {
      issues.push(issue("error", `kfd-2.claims[${index}].identity`, "public release claim must include id and statement"));
    }
    if (claim.public === false) {
      continue;
    }
    const missing = Array.isArray(claim.missingBindings) ? claim.missingBindings : [];
    if (missing.length > 0 || claim.status === "failed") {
      issues.push(issue("error", `kfd-2.claims[${index}].bindings`, "public release claim is missing machine-verifiable trust bindings", {
        id: claim.id || "",
        missingBindings: missing,
      }));
    } else if (claim.status === "downgraded" || claim.proseOnly) {
      issues.push(issue("warning", `kfd-2.claims[${index}].downgraded`, "public release claim is downgraded and needs human review", {
        id: claim.id || "",
        proseOnly: Boolean(claim.proseOnly),
      }));
    }
    for (const [riskIndex, risk] of arrayOrSingleton(claim.residualRisk || claim.residual_risk).entries()) {
      try {
        validateKfd2TrustTaxonomyEntry(risk, {
          kind: "residualRisk",
          label: `kfd-2.claims[${index}].residualRisk[${riskIndex}]`,
        });
      } catch (error) {
        issues.push(issue("error", `kfd-2.claims[${index}].residualRisk[${riskIndex}]`, error.message, {
          id: risk?.id || claim.id || "",
        }));
      }
    }
    for (const [reasonIndex, reason] of arrayOrSingleton(claim.downgradeReasons || claim.downgrade_reasons || claim.downgradeReason || claim.downgrade_reason).entries()) {
      try {
        validateKfd2TrustTaxonomyEntry(reason, {
          kind: "downgradeReason",
          label: `kfd-2.claims[${index}].downgradeReasons[${reasonIndex}]`,
        });
      } catch (error) {
        issues.push(issue("error", `kfd-2.claims[${index}].downgradeReasons[${reasonIndex}]`, error.message, {
          id: reason?.id || claim.id || "",
        }));
      }
    }
    if (String(claim.id || "").startsWith("kfd-3:")) {
      const trustProof = claim.trustProof && typeof claim.trustProof === "object" && !Array.isArray(claim.trustProof)
        ? claim.trustProof
        : undefined;
      if (!trustProof || trustProof.contract !== KFD2_TRUST_PROOF_CONTRACT) {
        issues.push(issue("error", `kfd-2.claims[${index}].trustProof`, "KFD-3 generated public claims must include a KFD-2 trust proof", {
          id: claim.id || "",
          expectedContract: KFD2_TRUST_PROOF_CONTRACT,
        }));
      } else {
        if (!trustProof.witnessHashes?.prebuildWitnessSha256 || !trustProof.witnessHashes?.artifactWitnessSha256) {
          issues.push(issue("error", `kfd-2.claims[${index}].trustProof.witnessHashes`, "KFD-2 trust proof must preserve KFD-3 witness hashes", {
            id: claim.id || "",
          }));
        }
        if (!trustProof.declaredCapabilityVerification?.result) {
          issues.push(issue("error", `kfd-2.claims[${index}].trustProof.declaredCapabilityVerification`, "KFD-2 trust proof must preserve declared capability verification", {
            id: claim.id || "",
          }));
        }
        if (!trustProof.reverseAudit?.status) {
          issues.push(issue("error", `kfd-2.claims[${index}].trustProof.reverseAudit`, "KFD-2 trust proof must preserve reverse audit result", {
            id: claim.id || "",
          }));
        }
        if (!trustProof.reverseAuditBoundary || typeof trustProof.reverseAuditBoundary !== "object" || Array.isArray(trustProof.reverseAuditBoundary)) {
          issues.push(issue("error", `kfd-2.claims[${index}].trustProof.reverseAuditBoundary`, "KFD-2 trust proof must preserve the reverse audit boundary", {
            id: claim.id || "",
          }));
        }
        if (!Array.isArray(trustProof.residualRisk)) {
          issues.push(issue("error", `kfd-2.claims[${index}].trustProof.residualRisk`, "KFD-2 trust proof must preserve residual risk as an array", {
            id: claim.id || "",
          }));
        } else {
          for (const [riskIndex, risk] of trustProof.residualRisk.entries()) {
            try {
              validateKfd2TrustTaxonomyEntry(risk, {
                kind: "residualRisk",
                label: `kfd-2.claims[${index}].trustProof.residualRisk[${riskIndex}]`,
              });
            } catch (error) {
              issues.push(issue("error", `kfd-2.claims[${index}].trustProof.residualRisk[${riskIndex}]`, error.message, {
                id: risk?.id || claim.id || "",
              }));
            }
          }
        }
        if (!trustProof.responsibility?.registryFactsOwner || !trustProof.responsibility?.artifactVerificationOwner || !trustProof.responsibility?.releasePassportProofOwner) {
          issues.push(issue("error", `kfd-2.claims[${index}].trustProof.responsibility`, "KFD-2 trust proof must preserve KFD-3 responsibility state", {
            id: claim.id || "",
          }));
        }
      }
    }
  }
  if (section.status === "failed") {
    issues.push(issue("error", "kfd-2.status", "kfd-2 release trust passport audit must not contain failed public claims"));
  } else if (section.status === "downgraded") {
    issues.push(issue("warning", "kfd-2.status", "kfd-2 release trust passport audit is downgraded by prose-only or residual-risk claims"));
  } else if (section.status !== "passed") {
    issues.push(issue("error", "kfd-2.status", "kfd-2 status must be passed, downgraded, or failed"));
  }
}

function validateKfdAgentHubReleaseEvidence(section, evidence, issues) {
  if (!section && !evidence) return;
  if (!section) {
    issues.push(issue("error", "kfdAgentHub.section.missing", "Agent Hub evidence is present without a release-passport section"));
    return;
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    issues.push(issue("error", "kfdAgentHub.evidence.missing", "release passport must resolve its Agent Hub evidence asset"));
    return;
  }
  let expected;
  try {
    expected = normalizeKfdAgentHubEvidence({ value: evidence });
  } catch (error) {
    issues.push(issue("error", "kfdAgentHub.evidence.invalid", error.message));
    return;
  }
  if (section.contract !== KFD_AGENT_HUB_RELEASE_EVIDENCE_CONTRACT) {
    issues.push(issue("error", "kfdAgentHub.contract", `kfdAgentHub.contract must be ${KFD_AGENT_HUB_RELEASE_EVIDENCE_CONTRACT}`));
  }
  for (const field of ["evidenceDigest", "reportDigest", "lockRoot"]) {
    if (section[field] !== expected[field]) {
      issues.push(issue("error", `kfdAgentHub.${field}`, `kfdAgentHub.${field} does not match the evidence asset`, {
        expected: expected[field],
        actual: section[field],
      }));
    }
  }
  if (stableJson(section.sourceCut) !== stableJson(expected.sourceCut) || stableJson(section.scope) !== stableJson(expected.scope)) {
    issues.push(issue("error", "kfdAgentHub.scope", "Agent Hub package cut or adapter scope does not match the evidence asset"));
  }
  if (section.qualifying !== false || section.certification !== false) {
    issues.push(issue("error", "kfdAgentHub.claimBoundary", "Agent Hub evidence must remain nonqualifying and non-certifying"));
  }
}

async function resolveSiblingJson(basePath, relativePath) {
  if (!basePath || !relativePath) {
    return undefined;
  }
  if (/^https?:\/\//.test(relativePath)) {
    return readJsonFromLocation(relativePath);
  }
  if (/^https?:\/\//.test(basePath)) {
    return readJsonFromLocation(new URL(relativePath, basePath).toString());
  }
  const candidate = path.resolve(path.dirname(basePath), relativePath);
  if (!fs.existsSync(candidate)) {
    return undefined;
  }
  return readJsonFile(candidate);
}

function artifactDigestValue(artifact = {}) {
  return optionalString(artifact.digest || artifact.sha256 || artifact.integrity || artifact.shasum);
}

function equivalentDigest(left, right) {
  if (!left || !right) {
    return false;
  }
  return left === right || left === `sha256:${right}` || `sha256:${left}` === right;
}

function artifactEvidenceKeys(artifact = {}) {
  const name = optionalString(artifact.name);
  if (!name) {
    return [];
  }
  const group = optionalString(artifact.group);
  const kind = optionalString(artifact.kind);
  const ref = optionalString(artifact.ref || artifact.version);
  const keys = [];
  if (group || kind || ref) {
    keys.push(["structured", group, kind, name, ref].join("\0"));
  }
  if (kind || ref) {
    keys.push(["structured", "", kind, name, ref].join("\0"));
  }
  if (kind) {
    keys.push(["structured", "", kind, name, ""].join("\0"));
  }
  keys.push(["name", name].join("\0"));
  return keys;
}

function indexEvidenceArtifacts(artifacts = []) {
  const index = new Map();
  for (const artifact of artifacts) {
    for (const key of artifactEvidenceKeys(artifact)) {
      const entries = index.get(key) || [];
      entries.push(artifact);
      index.set(key, entries);
    }
  }
  return index;
}

function findEvidenceForArtifact(artifact, evidenceIndex) {
  const artifactDigest = artifactDigestValue(artifact);
  for (const key of artifactEvidenceKeys(artifact)) {
    const entries = evidenceIndex.get(key) || [];
    if (entries.length === 0) {
      continue;
    }
    const matchingDigest = entries.find((entry) => equivalentDigest(artifactDigest, artifactDigestValue(entry)));
    if (matchingDigest) {
      return matchingDigest;
    }
    if (!key.startsWith("name\0") || entries.length === 1) {
      return entries[0];
    }
  }
  return undefined;
}

function validateReleaseEvidenceContracts({
  passport,
  artifactEvidence,
  impact,
  agentIndex,
  productMechanism,
  kfdAgentHubEvidence,
  kfdSupportEvidence,
  kfdAdopterManifest,
  kfdAdopterManifestGate,
  checkedAt,
  issues,
}) {
  validateContract(passport, RELEASE_PASSPORT_CONTRACT, "passport", issues);
  validateContract(artifactEvidence, ARTIFACT_EVIDENCE_CONTRACT, "artifactEvidence", issues);
  validateContract(impact, IMPACT_LEDGER_CONTRACT, "impact", issues);
  validateContract(agentIndex, AGENT_INDEX_CONTRACT, "agentIndex", issues);
  validateContract(productMechanism, PRODUCT_MECHANISM_CONTRACT, "productMechanism", issues);
  validateKfdAgentHubReleaseEvidence(passport?.kfdAgentHub, kfdAgentHubEvidence, issues);
  for (const entry of validateKfdAdopterReleaseEvidence({
    binding: passport?.kfdAdopter,
    artifactBinding: artifactEvidence?.kfdAdopter,
    manifest: kfdAdopterManifest,
    manifestGate: kfdAdopterManifestGate,
    legacyProjection: kfdSupportEvidence,
    passportLegacyProjection: passport?.kfdSupport,
    expectedSourceSha: optionalString(passport?.release?.sourceSha),
  })) {
    issues.push(issue("error", entry.code, entry.message, entry.details));
  }
  if (!passport?.kfdSupport && kfdSupportEvidence) {
    issues.push(issue("error", "kfdSupport.section", "KFD support evidence is present without a release-passport projection"));
  }

  for (const [index, value] of (passport?.githubArtifactAttestations || []).entries()) {
    try {
      const policy = normalizeGitHubArtifactAttestationPolicy(value);
      if (policy.caller.sourceSha !== String(passport?.release?.sourceSha || "").toLowerCase()) {
        issues.push(issue(
          "error",
          `githubArtifactAttestations[${index}].caller.sourceSha`,
          "attestation policy source SHA must match passport.release.sourceSha",
        ));
      }
      const artifact = (passport?.artifacts || []).find((entry) => entry.name === policy.subject.name);
      if (!artifact) {
        issues.push(issue(
          "error",
          `githubArtifactAttestations[${index}].subject.name`,
          `attestation subject ${policy.subject.name} is absent from the Release Passport artifacts`,
        ));
      } else if (artifact.sha256 !== policy.subject.digest.sha256) {
        issues.push(issue(
          "error",
          `githubArtifactAttestations[${index}].subject.digest`,
          `attestation subject ${policy.subject.name} digest differs from the Release Passport artifact`,
        ));
      }
    } catch (error) {
      issues.push(issue(
        "error",
        `githubArtifactAttestations[${index}]`,
        error.message,
      ));
    }
  }
}

function validateReleaseEvidenceAttachments({
  passport,
  artifactEvidence,
  normalizedPublishEvidence,
  releaseEvidenceDocuments,
  issues,
}) {
  const evidenceArtifacts = [
    ...(Array.isArray(artifactEvidence?.artifacts) ? artifactEvidence.artifacts : []),
    ...(normalizedPublishEvidence?.artifacts || []),
  ];
  const releaseEvidence = Array.isArray(passport?.releaseEvidence) ? passport.releaseEvidence : [];
  const releaseEvidenceByCoordinate = new Map(
    releaseEvidenceDocuments.map((entry) => [
      `${entry?.reference?.id || ""}\0${entry?.reference?.path || ""}`,
      entry,
    ]),
  );
  const releaseEvidenceIds = new Set();
  const releaseEvidencePaths = new Set();
  for (const [index, reference] of releaseEvidence.entries()) {
    const label = `releaseEvidence[${index}]`;
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
      issues.push(issue("error", `${label}.object`, `${label} must be a JSON object`));
      continue;
    }
    if (reference.contract !== RELEASE_EVIDENCE_ATTACHMENT_CONTRACT) {
      issues.push(issue("error", `${label}.contract`, `${label}.contract must be ${RELEASE_EVIDENCE_ATTACHMENT_CONTRACT}`));
    }
    if (!reference.id || !reference.path || !reference.sha256 || !reference.documentContract) {
      issues.push(issue("error", `${label}.identity`, `${label} must include id, path, sha256, and documentContract`));
      continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(reference.id)) {
      issues.push(issue("error", `${label}.id`, `${label}.id must use only letters, digits, dot, underscore, or hyphen`));
    }
    const expectedPath = `release-evidence-${reference.id}.json`;
    if (reference.path !== expectedPath) {
      issues.push(issue("error", `${label}.path`, `${label}.path must be ${expectedPath}`));
    }
    if (releaseEvidenceIds.has(reference.id)) {
      issues.push(issue("error", `${label}.id`, `${label}.id must be unique`));
    }
    if (releaseEvidencePaths.has(reference.path)) {
      issues.push(issue("error", `${label}.path`, `${label}.path must be unique`));
    }
    releaseEvidenceIds.add(reference.id);
    releaseEvidencePaths.add(reference.path);
    const loaded = releaseEvidenceByCoordinate.get(`${reference.id}\0${reference.path}`);
    if (!loaded?.document) {
      issues.push(issue("error", `${label}.missing`, `${label} document is not independently retrievable`, {
        id: reference.id,
        path: reference.path,
      }));
      continue;
    }
    const document = loaded.document;
    if (document.contract !== reference.documentContract) {
      issues.push(issue("error", `${label}.documentContract`, `${label} document contract differs from its passport reference`));
    }
    const digest = sha256Text(stableJson(document));
    if (digest !== reference.sha256) {
      issues.push(issue("error", `${label}.sha256`, `${label} document digest differs from its passport reference`));
    }
    for (const field of ["sourceSha", "tag", "channel"]) {
      const expected = passport?.release?.[field] || "";
      const declared = document?.release?.[field] || "";
      if (!declared || declared !== expected || reference?.release?.[field] !== expected) {
        issues.push(issue("error", `${label}.release.${field}`, `${label} ${field} must match the release passport`));
      }
    }
  }
  return { evidenceArtifacts, releaseEvidence };
}

function validatePublishEvidenceSection({ passport, publishEvidence, normalizedPublishEvidence, issues }) {
  const publishEvidenceSupplied =
    Boolean(passport?.evidence?.publishEvidence) ||
    (publishEvidence && typeof publishEvidence === "object" && Object.keys(publishEvidence).length > 0);
  if (!publishEvidenceSupplied && !passport?.packageSet) {
    return;
  }
  const checkPublishField = (value, label) => {
    if (!value) {
      issues.push(issue("error", `publishEvidence.${label}`, `publishEvidence.${label} is required`));
    }
  };
  if (Number(normalizedPublishEvidence?.schema) !== 1) {
    issues.push(issue("error", "publishEvidence.schema", "publishEvidence.schema must be 1"));
  }
  for (const field of ["version", "channel", "sourceSha", "releaseSha", "targetRef", "releaseMaterialSha", "publishToolingSha"]) {
    checkPublishField(normalizedPublishEvidence?.[field], field);
  }
  if (!Array.isArray(normalizedPublishEvidence?.artifacts) || normalizedPublishEvidence.artifacts.length === 0) {
    issues.push(issue("error", "publishEvidence.artifacts", "publishEvidence.artifacts must include published artifacts"));
  }
  if ((normalizedPublishEvidence?.artifacts || []).some((artifact) => artifact.action)) {
    try {
      const validation = validateTransactionPublishEvidence({
        evidence: publishEvidence,
        version: normalizedPublishEvidence.version,
        channel: normalizedPublishEvidence.channel,
        sourceSha: normalizedPublishEvidence.sourceSha,
        releaseSha: normalizedPublishEvidence.releaseSha,
        targetRef: normalizedPublishEvidence.targetRef,
        releaseMaterialSha: normalizedPublishEvidence.releaseMaterialSha,
        publishToolingSha: normalizedPublishEvidence.publishToolingSha,
      });
      for (const error of validation.errors) {
        issues.push(issue("error", "publishEvidence.artifactProvenance", error));
      }
    } catch (error) {
      issues.push(issue(
        "error",
        "publishEvidence.artifactProvenance",
        `publish artifact provenance is invalid: ${error.message}`,
      ));
    }
  }
  for (const field of ["sourceSha", "releaseSha", "targetRef"]) {
    if (passport?.release?.[field] && normalizedPublishEvidence?.[field] && passport.release[field] !== normalizedPublishEvidence[field]) {
      issues.push(issue(
        "error",
        `publishEvidence.${field}.mismatch`,
        `publishEvidence.${field} must match passport.release.${field}`,
      ));
    }
  }
}

function validateReleaseArtifacts({ artifacts, evidenceIndex, issues }) {
  if (artifacts.length === 0) {
    issues.push(issue("error", "artifacts.empty", "release passport must list at least one artifact"));
  }
  for (const artifact of artifacts) {
    if (!artifact.name) {
      issues.push(issue("error", "artifact.name", "artifact name is required"));
      continue;
    }
    const evidence = findEvidenceForArtifact(artifact, evidenceIndex);
    if (!evidence) {
      issues.push(issue("error", "artifact.evidence.missing", `artifact ${artifact.name} is missing evidence`));
      continue;
    }
    const evidenceDigest = artifactDigestValue(evidence);
    if (!evidenceDigest) {
      issues.push(issue("error", "artifact.digest", `artifact ${artifact.name} must have a digest`));
    }
    if (artifact.sha256 && evidence.sha256 && artifact.sha256 !== evidence.sha256) {
      issues.push(issue("error", "artifact.sha256.mismatch", `artifact ${artifact.name} digest differs between passport and evidence`));
    }
    if (artifact.digest && evidenceDigest && artifact.digest !== evidenceDigest && artifact.digest !== `sha256:${evidenceDigest}`) {
      issues.push(issue("error", "artifact.digest.mismatch", `artifact ${artifact.name} digest differs between passport and evidence`));
    }
    for (const field of ["action", "platform", "contract_major", "parent_digest", "content", "release", "verification"]) {
      if (
        Object.prototype.hasOwnProperty.call(evidence, field) &&
        stableJson(artifact[field]) !== stableJson(evidence[field])
      ) {
        issues.push(issue(
          "error",
          `artifact.${field}.mismatch`,
          `artifact ${artifact.name} ${field} differs between passport and publish evidence`,
        ));
      }
    }
  }
}

function validatePackageSet({ passport, evidenceIndex, issues }) {
  if (!passport?.packageSet) {
    return;
  }
  const main = passport.packageSet.main || {};
  const checkPackageEntry = (entry, label, role) => {
    if (!entry.name || !entry.version) {
      issues.push(issue("error", `${label}.identity`, `${label} must include name and version`));
    }
    if (!entry.distTag) {
      issues.push(issue("error", `${label}.distTag`, `${label} must include distTag`));
    }
    if (!entry.digest) {
      issues.push(issue("error", `${label}.digest`, `${label} must include digest`));
    }
    if (entry.name && entry.version) {
      const artifact = findEvidenceForArtifact({
        group: "node",
        kind: "npm",
        name: entry.name,
        ref: entry.version,
        digest: entry.digest,
      }, evidenceIndex);
      if (!artifact) {
        issues.push(issue("error", `${label}.artifact`, `${label} must have matching npm artifact evidence`, {
          role,
          name: entry.name,
          version: entry.version,
        }));
      }
    }
  };
  checkPackageEntry(main, "packageSet.main", "main");
  const platforms = Array.isArray(passport.packageSet.platforms) ? passport.packageSet.platforms : [];
  if (platforms.length < 3) {
    issues.push(issue("error", "packageSet.platforms", "packageSet must include at least three platform packages"));
  }
  for (const [index, entry] of platforms.entries()) {
    checkPackageEntry(entry, `packageSet.platforms[${index}]`, "platform");
  }
  if (!Array.isArray(passport?.publish?.packages) || passport.publish.packages.length !== 1 + platforms.length) {
    issues.push(issue("error", "publish.packages", "publish.packages must summarize main and platform packages"));
  }
}

function validateReleaseState({ passport, issues }) {
  if (passport?.trustedPublishing) {
    if (!passport.trustedPublishing.provider) {
      issues.push(issue("error", "trustedPublishing.provider", "trustedPublishing.provider is required"));
    }
    if (passport.trustedPublishing.auth !== "trusted-publishing") {
      issues.push(issue("error", "trustedPublishing.auth", "trustedPublishing.auth must be trusted-publishing"));
    }
    if (passport.trustedPublishing.enabled !== true) {
      issues.push(issue("error", "trustedPublishing.enabled", "trusted publishing evidence must be enabled"));
    }
  }
  if (passport?.transaction) {
    if (!passport.transaction.state) {
      issues.push(issue("error", "transaction.state", "transaction.state is required"));
    } else if (passport.transaction.state !== "complete") {
      issues.push(issue("error", "transaction.state", "release passport transaction state must be complete"));
    }
    for (const field of ["exactTag", "releaseSha", "releaseMaterialSha", "stateRef"]) {
      if (!passport.transaction[field]) {
        issues.push(issue("error", `transaction.${field}`, `transaction.${field} is required`));
      }
    }
  }
  if (passport?.anchorManifest) {
    if (!passport.anchorManifest.sha256) {
      issues.push(issue("error", "anchorManifest.sha256", "anchorManifest.sha256 is required"));
    }
    if (!passport.anchorManifest.fields || typeof passport.anchorManifest.fields !== "object" || Array.isArray(passport.anchorManifest.fields)) {
      issues.push(issue("error", "anchorManifest.fields", "anchorManifest.fields must be an object"));
    }
  }
  if (!passport?.runnerPolicy?.productionDefault) {
    issues.push(issue("warning", "runnerPolicy.productionDefault", "runner policy should record the production default"));
  }
}

function validateVersionMaterial({ passport, issues }) {
  if (!passport?.versionMaterial) {
    return;
  }
  if (passport.versionMaterial.contract !== "kungfu-buildchain-anchored-version-material/v1") {
    issues.push(issue(
      "error",
      "versionMaterial.contract",
      "versionMaterial contract must be kungfu-buildchain-anchored-version-material/v1",
    ));
  }
  if (!passport.versionMaterial.alpha?.tree || !passport.versionMaterial.release?.tree) {
    issues.push(issue(
      "error",
      "versionMaterial.tree",
      "versionMaterial must record alpha and release tree identities",
    ));
  }
  const allowedPaths = Array.isArray(passport.versionMaterial.allowedPaths)
    ? passport.versionMaterial.allowedPaths
    : [];
  const derivedFiles = Array.isArray(passport.versionMaterial.derivedFiles)
    ? passport.versionMaterial.derivedFiles
    : [];
  for (const [index, file] of derivedFiles.entries()) {
    if (!file?.path || !file?.sha256 || !allowedPaths.includes(file.path)) {
      issues.push(issue(
        "error",
        `versionMaterial.derivedFiles[${index}]`,
        "derived version material must have a path, digest, and matching allowed path",
      ));
    }
  }
  for (const side of ["alpha", "release"]) {
    const material = Array.isArray(passport.versionMaterial[side]?.material)
      ? passport.versionMaterial[side].material
      : [];
    for (const [index, file] of material.entries()) {
      if (
        !file?.path ||
        !allowedPaths.includes(file.path) ||
        file.present !== true ||
        !/^sha256:[0-9a-f]{64}$/.test(file.sha256 || "")
      ) {
        issues.push(issue(
          "error",
          `versionMaterial.${side}.material[${index}]`,
          "version material must have an allowed path, present bytes, and sha256 digest",
        ));
      }
    }
  }
}

function createReleaseImpactContext({ passport, impact }) {
  const surfaceImpacts = Array.isArray(impact?.surfaceImpacts) ? impact.surfaceImpacts : [];
  const passportSurfaceImpacts = Array.isArray(passport?.surfaceImpacts) ? passport.surfaceImpacts : [];
  const impactRelease = impact?.release && typeof impact.release === "object" && !Array.isArray(impact.release)
    ? impact.release
    : {};
  const passportVersion = optionalString(passport?.release?.publishedVersion || passport?.release?.package?.version);
  const passportTargetRef = optionalString(passport?.release?.targetRef || passport?.release?.target_ref);
  const passportTargetLineMatch = passportTargetRef.match(/^(?:alpha|release)\/v(\d+)\/v\1\.(\d+)$/);
  return {
    surfaceImpacts,
    passportSurfaceImpacts,
    impactVersion: optionalString(impactRelease.version),
    impactLine: optionalString(impactRelease.line),
    passportVersion,
    passportLine: optionalString(
      passport?.release?.line ||
      (passportTargetLineMatch ? `v${passportTargetLineMatch[1]}.${passportTargetLineMatch[2]}` : ""),
    ),
    impactClassification: normalizeImpactLevel(impact?.classification),
    declaredFinalImpact: normalizeImpactLevel(impact?.versionImpact?.final || impact?.classification),
    computedFinalImpact: highestImpactLevel(surfaceImpacts.map((entry) => entry.impact)),
    requiredSurfaceImpacts: surfaceImpactRequirement({ passport, impact }),
  };
}

function validatePassportTrustSections({ passport, issues }) {
  const kfd1Metadata = resolveKfd1Metadata();
  issues.push(...validateKfd1ReleaseGateEvidence(passport?.[kfd1Metadata.key], { metadata: kfd1Metadata }));
  validateKfd2ReleaseTrustPassportAudit(passport?.["kfd-2"], issues);
  const fallbackKfd3Section = passport?.["kfd-3"];
  try {
    const kfd3Metadata = resolveKfd3Metadata();
    const kfd3Section = passport?.[kfd3Metadata.key] || fallbackKfd3Section;
    if (kfd3Section) {
      issues.push(...validateKfd3CollaborationInterfaceReleaseGateEvidence(kfd3Section, { metadata: kfd3Metadata }));
    }
  } catch (error) {
    if (fallbackKfd3Section) {
      issues.push(issue("error", "kfd-3.metadata", error.message));
    }
  }
  if (!passport?.invariantPassports) {
    return;
  }
  const section = passport.invariantPassports;
  if (section.contract !== INVARIANT_PASSPORT_GATE_CONTRACT) {
    issues.push(issue("error", "invariantPassports.contract", `invariantPassports.contract must be ${INVARIANT_PASSPORT_GATE_CONTRACT}`));
  }
  if (section.result !== "passed") {
    issues.push(issue("error", "invariantPassports.result", "invariantPassports.result must be passed"));
  }
  if (!Array.isArray(section.passports) || section.passports.length === 0) {
    issues.push(issue("error", "invariantPassports.empty", "invariantPassports must contain at least one verified passport"));
  }
  const acceptedSourceShas = new Set([
    passport?.release?.sourceSha,
    passport?.release?.builtSourceSha,
    passport?.release?.promotionChannelSha,
  ].filter(Boolean));
  for (const [index, entry] of (section.passports || []).entries()) {
    const prefix = `invariantPassports.passports[${index}]`;
    if (entry.verdict !== "verified") issues.push(issue("error", `${prefix}.verdict`, `${prefix}.verdict must be verified`));
    if (entry.coverage?.complete !== true) issues.push(issue("error", `${prefix}.coverage`, `${prefix}.coverage.complete must be true`));
    if (entry.source?.dirty !== false) issues.push(issue("error", `${prefix}.source.dirty`, `${prefix}.source.dirty must be false`));
    if (acceptedSourceShas.size > 0 && !acceptedSourceShas.has(entry.source?.revision)) {
      issues.push(issue("error", `${prefix}.source.revision`, `${prefix}.source.revision must match a release source identity`));
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(optionalString(entry.passportRoot))) issues.push(issue("error", `${prefix}.passportRoot`, `${prefix}.passportRoot is invalid`));
    if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) issues.push(issue("error", `${prefix}.platforms`, `${prefix}.platforms must be non-empty`));
    if (!Array.isArray(entry.residualRisk)) issues.push(issue("error", `${prefix}.residualRisk`, `${prefix}.residualRisk must be an array`));
  }
}

function validateReleaseImpact({ passport, impact, context, issues }) {
  const {
    surfaceImpacts,
    passportSurfaceImpacts,
    impactVersion,
    impactLine,
    passportVersion,
    passportLine,
    impactClassification,
    declaredFinalImpact,
    computedFinalImpact,
    requiredSurfaceImpacts,
  } = context;
  if (impactVersion) {
    if (!impactLine) {
      issues.push(issue("error", "impact.release.line", "version-bound impact requires release.line"));
    } else if (passportLine && impactLine !== passportLine) {
      issues.push(issue("error", "impact.release.line", "impact release line must match the release passport line", {
        impactLine,
        passportLine,
      }));
    }
    if (passportVersion && impactVersion !== passportVersion) {
      issues.push(issue("error", "impact.release.version", "impact release version must match the published release version", {
        impactVersion,
        passportVersion,
      }));
    }
    if (!["patch", "minor", "major"].includes(impactClassification)) {
      issues.push(issue("error", "impact.classification", "version-bound impact classification must be patch, minor, or major"));
    } else if (impactClassification !== declaredFinalImpact) {
      issues.push(issue("error", "impact.classification", "version-bound impact classification must match versionImpact.final", {
        classification: impactClassification,
        versionImpact: declaredFinalImpact,
      }));
    }
    if (!optionalString(impact?.summary).trim()) {
      issues.push(issue("error", "impact.summary", "version-bound impact summary is required"));
    }
    if (surfaceImpacts.length === 0) {
      issues.push(issue("error", "impact.surfaceImpacts.required", "version-bound impact requires surfaceImpacts[]", {
        type: "version-bound-release-impact",
      }));
    }
  }
  if (requiredSurfaceImpacts.required && surfaceImpacts.length === 0) {
    issues.push(issue("error", "impact.surfaceImpacts.required", "surfaceImpacts[] is required for this release passport type", requiredSurfaceImpacts));
  }
  if (surfaceImpacts.length > 0) {
    for (const [index, entry] of surfaceImpacts.entries()) {
      if (!entry.id) {
        issues.push(issue("error", `impact.surfaceImpacts[${index}].id`, "surface impact id is required"));
      }
      if (!VERSION_IMPACT_ORDER.has(entry.impact)) {
        issues.push(issue("error", `impact.surfaceImpacts[${index}].impact`, "surface impact must be patch, minor, or major"));
      }
      if (!entry.rationale) {
        issues.push(issue("error", `impact.surfaceImpacts[${index}].rationale`, "surface impact rationale is required"));
      }
    }
    if (!impact?.versionImpact?.rationale) {
      issues.push(issue("error", "impact.versionImpact.rationale", "version impact rationale is required when surface impacts are supplied"));
    }
    if (declaredFinalImpact !== computedFinalImpact) {
      issues.push(issue("error", "impact.versionImpact.final", "versionImpact.final must equal the highest surface impact", {
        declared: declaredFinalImpact,
        computed: computedFinalImpact,
      }));
    }
    if (stableJson(passportSurfaceImpacts) !== stableJson(surfaceImpacts)) {
      issues.push(issue("error", "passport.surfaceImpacts", "passport.surfaceImpacts must mirror impact.surfaceImpacts"));
    }
  }
  if (passport?.versionImpact?.final && impact?.versionImpact?.final && passport.versionImpact.final !== impact.versionImpact.final) {
    issues.push(issue("error", "passport.versionImpact.final", "passport.versionImpact.final must match impact.versionImpact.final"));
  }
}

function buildReleaseCheckReport({
  checkedAt,
  issues,
  requiredSurfaceImpacts,
  artifacts,
  evidenceArtifacts,
  passport,
  impact,
  agentIndex,
  productMechanism,
  surfaceImpacts,
  releaseEvidence,
}) {
  const ok = issues.every((entry) => entry.level !== "error");
  return {
    schemaVersion: 1,
    contract: RELEASE_CHECK_REPORT_CONTRACT,
    checkedAt,
    ok,
    trust: ok ? "pass" : "fail",
    surfaceImpactRequirement: requiredSurfaceImpacts,
    completeness: {
      artifactCount: artifacts.length,
      evidenceArtifactCount: evidenceArtifacts.length,
      packageSetPresent: Boolean(passport?.packageSet),
      trustedPublishingPresent: Boolean(passport?.trustedPublishing),
      transactionPresent: Boolean(passport?.transaction),
      anchorManifestPresent: Boolean(passport?.anchorManifest),
      buildSummaryPresent: Boolean(passport?.buildSummary),
      platformArtifactManifestCount: Array.isArray(passport?.platformArtifactManifests)
        ? passport.platformArtifactManifests.length
        : 0,
      distTagPromotionEvidencePresent: Boolean(passport?.distTagPromotion),
      impactPresent: Boolean(impact),
      agentIndexPresent: Boolean(agentIndex),
      productMechanismPresent: Boolean(productMechanism),
      surfaceImpactsRequired: requiredSurfaceImpacts.required,
      surfaceImpactCount: surfaceImpacts.length,
      versionImpact: impact?.versionImpact?.final || "",
      releaseEvidenceCount: releaseEvidence.length,
    },
    issues,
  };
}

export function createReleaseCheckReport({
  passport,
  artifactEvidence,
  publishEvidence,
  impact,
  agentIndex,
  productMechanism,
  kfdAgentHubEvidence,
  kfdSupportEvidence,
  kfdAdopterManifest,
  kfdAdopterManifestGate,
  releaseEvidenceDocuments = [],
  checkedAt = nowIso(),
} = {}) {
  const issues = [];
  validateReleaseEvidenceContracts({
    passport,
    artifactEvidence,
    impact,
    agentIndex,
    productMechanism,
    kfdAgentHubEvidence,
    kfdSupportEvidence,
    kfdAdopterManifest,
    kfdAdopterManifestGate,
    checkedAt,
    issues,
  });

  const tag = passport?.release?.tag || "";
  if (!tag) {
    issues.push(issue("error", "release.tag", "release.tag is required"));
  }
  if (!passport?.release?.sourceSha) {
    issues.push(issue("warning", "release.sourceSha", "release.sourceSha is recommended"));
  }
  const artifacts = Array.isArray(passport?.artifacts) ? passport.artifacts : [];
  const normalizedPublishEvidence = normalizePublishEvidence(publishEvidence);
  const { evidenceArtifacts, releaseEvidence } = validateReleaseEvidenceAttachments({
    passport,
    artifactEvidence,
    normalizedPublishEvidence,
    releaseEvidenceDocuments,
    issues,
  });
  validatePublishEvidenceSection({ passport, publishEvidence, normalizedPublishEvidence, issues });
  const evidenceIndex = indexEvidenceArtifacts(evidenceArtifacts);
  validateReleaseArtifacts({ artifacts, evidenceIndex, issues });
  validatePackageSet({ passport, evidenceIndex, issues });
  validateReleaseState({ passport, issues });
  validateVersionMaterial({ passport, issues });
  const impactContext = createReleaseImpactContext({ passport, impact });
  const { requiredSurfaceImpacts, surfaceImpacts } = impactContext;
  validatePassportTrustSections({ passport, issues });
  validateReleaseImpact({ passport, impact, context: impactContext, issues });
  return buildReleaseCheckReport({
    checkedAt,
    issues,
    requiredSurfaceImpacts,
    artifacts,
    evidenceArtifacts,
    passport,
    impact,
    agentIndex,
    productMechanism,
    surfaceImpacts,
    releaseEvidence,
  });
}

export async function readJsonFromLocation(
  location,
  redirectCount = 0,
  { timeoutMs = 15_000 } = {},
) {
  const input = nonEmptyString(location, "location");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive integer");
  }
  if (redirectCount > 5) {
    throw new Error(`too many redirects while reading ${input}`);
  }
  if (/^https?:\/\//.test(input)) {
    const client = input.startsWith("https:") ? https : http;
    return new Promise((resolve, reject) => {
      const request = client.get(input, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          const nextLocation = new URL(response.headers.location, input).toString();
          response.resume();
          readJsonFromLocation(nextLocation, redirectCount + 1, { timeoutMs }).then(resolve, reject);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} while reading ${input}`));
          response.resume();
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      });
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`timed out after ${timeoutMs}ms while reading ${input}`));
      });
      request.on("error", reject);
    });
  }
  return readJsonFile(input);
}

export async function verifyReleasePassport({
  passportLocation,
  artifactEvidenceLocation = "",
  publishEvidenceLocation = "",
  impactLocation = "",
  agentIndexLocation = "",
  productMechanismLocation = "",
  kfdAgentHubEvidenceLocation = "",
  kfdAdopterManifestLocation = "",
  kfdAdopterManifestGateLocation = "",
  kfdSupportEvidenceLocation = "",
  checkedAt = nowIso(),
} = {}) {
  const evidence = await resolveReleasePassportVerificationInputs({
    passportLocation,
    locations: {
      artifactEvidence: artifactEvidenceLocation,
      publishEvidence: publishEvidenceLocation,
      impact: impactLocation,
      agentIndex: agentIndexLocation,
      productMechanism: productMechanismLocation,
      kfdAgentHubEvidence: kfdAgentHubEvidenceLocation,
      kfdAdopterManifest: kfdAdopterManifestLocation,
      kfdAdopterManifestGate: kfdAdopterManifestGateLocation,
      kfdSupportEvidence: kfdSupportEvidenceLocation,
    },
    readJson: readJsonFromLocation,
    resolveSibling: resolveSiblingJson,
  });
  return createReleaseCheckReport({
    ...evidence,
    checkedAt,
  });
}

export async function explainReleasePassport({ passportLocation, forAudience = "human" } = {}) {
  const report = await verifyReleasePassport({ passportLocation });
  const passport = await readJsonFromLocation(passportLocation);
  const nextAction = report.ok
    ? "install-or-upgrade-after-policy-review"
    : "block-release-and-report-verification-failure";
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-explanation",
    audience: forAudience,
    release: passport.release,
    trust: report.trust,
    complete: report.ok,
    artifactCount: report.completeness.artifactCount,
    runnerPolicy: passport.runnerPolicy,
    impact: {
      versionImpact: passport.versionImpact || {},
      surfaceImpacts: Array.isArray(passport.surfaceImpacts) ? passport.surfaceImpacts : [],
      surfaceImpactRequirement: report.surfaceImpactRequirement,
      breaking: Boolean(passport.versionImpact?.final === "major"),
      migrationRequired: Boolean(passport.versionImpact?.final === "major"),
      summary: passport.versionImpact?.rationale || "",
    },
    recovery: passport.recovery,
    nextAction,
    issues: report.issues,
  };
}

export function makeReleasePassportFixtureAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const names = [
    `buildchain-${process.platform}-${process.arch}.tar.gz`,
    "checksums.txt",
  ];
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), `${name}${os.EOL}`);
  }
  return discoverAssetsFromDir(dir);
}

export function validateKnownReleasePassportContracts() {
  return [...CONTRACTS];
}
