import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

export const RELEASE_PASSPORT_CONTRACT = "kungfu-buildchain-release-passport";
export const ARTIFACT_EVIDENCE_CONTRACT = "kungfu-buildchain-artifact-evidence";
export const IMPACT_LEDGER_CONTRACT = "kungfu-buildchain-impact";
export const AGENT_INDEX_CONTRACT = "kungfu-buildchain-agent-index";
export const PRODUCT_MECHANISM_CONTRACT = "kungfu-buildchain-product-mechanism";
export const RELEASE_CHECK_REPORT_CONTRACT = "kungfu-buildchain-release-check-report";

const CONTRACTS = new Set([
  RELEASE_PASSPORT_CONTRACT,
  ARTIFACT_EVIDENCE_CONTRACT,
  IMPACT_LEDGER_CONTRACT,
  AGENT_INDEX_CONTRACT,
  PRODUCT_MECHANISM_CONTRACT,
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

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
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

function defaultProductMechanism({ repository = "", productName = "Buildchain" } = {}) {
  return {
    schemaVersion: 1,
    contract: PRODUCT_MECHANISM_CONTRACT,
    product: {
      name: productName,
      repository,
      northStar: "GitHub-native release passport protocol for binary and multi-artifact products.",
    },
    trustModel: {
      executionSubstrate: "github-actions",
      releaseAuthority: "protected Buildchain channel refs, exact tags, and release passport evidence",
      runnerRequirement: "runner facts are recorded, but the protocol is runner-agnostic",
    },
    compatibility: {
      promise: "release passport schemas are welded surfaces; additive fields are allowed, breaking semantic changes require a new major line",
      kfd: "KFD-1",
    },
  };
}

function defaultImpact({ tag = "", line = "", decision = "unknown" } = {}) {
  const finalImpact = normalizeImpactLevel(decision);
  return {
    schemaVersion: 1,
    contract: IMPACT_LEDGER_CONTRACT,
    release: { tag, line },
    versionImpact: {
      final: finalImpact,
      source: "default",
      rationale: "No surface impact classification was supplied.",
    },
    surfaceImpacts: [],
    classification: finalImpact,
    breaking: finalImpact === "major",
    security: false,
    migrationRequired: finalImpact === "major",
    summary: "No release impact summary was supplied.",
    recovery: {
      rollback: "Use the previous exact release tag or previous floating channel ref.",
      block: "Fail closed if release passport verification fails.",
    },
  };
}

function defaultAgentIndex({ tag = "", passportPath = "buildchain.release.json" } = {}) {
  return {
    schemaVersion: 1,
    contract: AGENT_INDEX_CONTRACT,
    release: { tag },
    entrypoints: [
      {
        id: "release-passport",
        kind: "json",
        path: passportPath,
        description: "Read this first to verify release completeness, artifacts, impact, and recovery pointers.",
      },
      {
        id: "llms",
        kind: "text",
        path: "llms.txt",
        description: "Short agent-readable release instructions.",
      },
    ],
  };
}

function defaultLlmsText({ tag = "", passportPath = "buildchain.release.json" } = {}) {
  return [
    "# Buildchain Release Passport",
    "",
    `Release: ${tag || "unknown"}`,
    "",
    `Start with ${passportPath}. Verify artifact-evidence.json before installing binaries.`,
    "If verification fails, do not install or promote this release.",
  ].join("\n");
}

function parseJsonInput(value, fallback = undefined) {
  const input = String(value || "").trim();
  if (!input) {
    return fallback;
  }
  if (fs.existsSync(input)) {
    return readJsonFile(input);
  }
  return JSON.parse(input);
}

function parseJsonInputWithMeta(value, fallback = undefined) {
  const input = String(value || "").trim();
  if (!input) {
    return { value: fallback, path: "", sha256: "" };
  }
  if (fs.existsSync(input)) {
    return {
      value: readJsonFile(input),
      path: input,
      sha256: sha256File(input),
    };
  }
  const parsed = JSON.parse(input);
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
  return {
    group: optionalString(artifact.group),
    kind: optionalString(artifact.kind),
    name,
    ref: optionalString(artifact.ref || artifact.version),
    digest: optionalString(artifact.digest || artifact.sha256 || artifact.integrity || artifact.shasum),
    evidence: optionalString(artifact.evidence),
  };
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

export function createArtifactEvidence({ assets = [], repository = "", tag = "", sourceSha = "", workflow = {} } = {}) {
  const normalizedAssets = assets.map((asset, index) => normalizeAsset(asset, index));
  return {
    schemaVersion: 1,
    contract: ARTIFACT_EVIDENCE_CONTRACT,
    repository: optionalString(repository),
    release: { tag: optionalString(tag), sourceSha: optionalString(sourceSha) },
    generatedAt: nowIso(),
    runner: {
      kind: optionalString(workflow.runnerKind || workflow.runner?.kind || ""),
      os: optionalString(workflow.runnerOs || workflow.runner?.os || ""),
      arch: optionalString(workflow.runnerArch || workflow.runner?.arch || ""),
      labels: Array.isArray(workflow.runnerLabels) ? workflow.runnerLabels : [],
      image: optionalString(workflow.runnerImage || workflow.runner?.image || ""),
    },
    workflow: {
      name: optionalString(workflow.name),
      runId: optionalString(workflow.runId),
      runAttempt: optionalString(workflow.runAttempt),
      url: optionalString(workflow.url),
    },
    artifacts: normalizedAssets.map((asset) => ({
      name: asset.name,
      kind: asset.kind,
      platform: asset.platform,
      size: asset.size,
      sha256: asset.sha256,
      url: asset.url,
      githubAssetId: asset.githubAssetId,
      attestation: optionalString(asset.attestation || ""),
    })),
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
  publishEvidence = undefined,
  trustedPublishing = undefined,
  transaction = undefined,
  buildSummary = undefined,
  platformArtifactManifests = [],
  distTagPromotionEvidence = undefined,
  release = {},
  publish = {},
  impact = undefined,
  workflow = {},
} = {}) {
  const normalizedTag = nonEmptyString(tag, "tag");
  const artifactEvidence = createArtifactEvidence({ assets, repository, tag: normalizedTag, sourceSha, workflow });
  const normalizedPublishEvidence = normalizePublishEvidence(publishEvidence);
  const normalizedPackageSet = normalizePackageSet(packageSet, { packageName, packageVersion, publish });
  const normalizedTrustedPublishing = normalizeTrustedPublishing(trustedPublishing, { workflow, publish });
  const normalizedTransaction = normalizeTransaction(transaction);
  const normalizedBuildSummary = buildSummary ? normalizeEvidenceDocument(buildSummary, "buildSummary") : undefined;
  const normalizedPlatformArtifactManifests = (platformArtifactManifests || [])
    .map((manifest, index) => normalizePlatformArtifactManifest(manifest, index))
    .filter(Boolean);
  const normalizedDistTagPromotionEvidence = distTagPromotionEvidence
    ? normalizeEvidenceDocument(distTagPromotionEvidence, "distTagPromotionEvidence")
    : undefined;
  const normalizedImpact = normalizeImpactLedger(impact, { tag: normalizedTag, line });
  const publishArtifacts = normalizedPublishEvidence?.artifacts || [];
  const normalizedPublishSummary = normalizePublishSummary({
    packageSet: normalizedPackageSet,
    publishEvidence: normalizedPublishEvidence,
    publish,
  });
  const releaseMaterialSha = optionalString(
    release.releaseMaterialSha ||
    release.release_material_sha ||
    normalizedPublishEvidence?.releaseMaterialSha ||
    normalizedTransaction?.releaseMaterialSha,
  );
  const releaseSha = optionalString(
    release.releaseSha ||
    release.release_sha ||
    normalizedPublishEvidence?.releaseSha ||
    normalizedTransaction?.releaseSha,
  );
  const targetRef = optionalString(release.targetRef || release.target_ref || normalizedPublishEvidence?.targetRef);
  const packageDisplayVersion = optionalString(
    packageVersion ||
    normalizedPackageSet?.main?.version ||
    normalizedPublishSummary?.packages?.find((entry) => entry.role === "main")?.publishedVersion ||
    normalizedPublishEvidence?.version ||
    normalizedTransaction?.version ||
    readPackageVersion(cwd),
  );
  const publishedVersion = optionalString(
    release.publishedVersion ||
    release.published_version ||
    packageDisplayVersion,
  );
  const internalVersion = optionalString(
    release.internalVersion ||
    release.internal_version ||
    normalizedTransaction?.version,
  );
  return {
    schemaVersion: 1,
    contract: RELEASE_PASSPORT_CONTRACT,
    generatedAt: nowIso(),
    product: {
      name: optionalString(productName || "Buildchain"),
      repository: optionalString(repository),
      mechanism: productMechanismPath,
    },
    release: {
      tag: normalizedTag,
      internalTag: optionalString(release.internalTag || release.internal_tag || normalizedTag),
      internalVersion,
      publishedVersion,
      versionLabel: optionalString(release.versionLabel || release.version_label || publishedVersion || normalizedTag),
      line: optionalString(line),
      sourceSha: optionalString(sourceSha),
      channel: optionalString(release.channel || normalizedPublishEvidence?.channel || publish.channel),
      targetRef,
      releaseSha,
      releaseMaterialSha,
      builtSourceSha: optionalString(release.builtSourceSha || release.built_source_sha),
      builtSourceTreeSha: optionalString(release.builtSourceTreeSha || release.built_source_tree_sha),
      promotionChannelSha: optionalString(release.promotionChannelSha || release.promotion_channel_sha),
      promotionChannelTreeSha: optionalString(release.promotionChannelTreeSha || release.promotion_channel_tree_sha),
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
    ...(normalizedPackageSet ? { packageSet: normalizedPackageSet } : {}),
    ...(normalizedPublishSummary ? { publish: normalizedPublishSummary } : {}),
    ...(anchorManifest ? { anchorManifest } : {}),
    ...(normalizedTrustedPublishing ? { trustedPublishing: normalizedTrustedPublishing } : {}),
    ...(normalizedTransaction ? { transaction: normalizedTransaction } : {}),
    ...(normalizedBuildSummary ? { buildSummary: normalizedBuildSummary } : {}),
    ...(normalizedPlatformArtifactManifests.length > 0 ? { platformArtifactManifests: normalizedPlatformArtifactManifests } : {}),
    ...(normalizedDistTagPromotionEvidence ? { distTagPromotion: normalizedDistTagPromotionEvidence } : {}),
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
        group: artifact.group,
        kind: artifact.kind,
        name: artifact.name,
        ref: artifact.ref,
        digest: artifact.digest,
        evidence: publishEvidencePath || artifact.evidence || artifactEvidencePath,
      })),
    ],
    evidence: {
      artifactEvidence: artifactEvidencePath,
      publishEvidence: publishEvidencePath,
      transactionState: transactionStatePath,
      buildSummary: normalizedBuildSummary?.path || "",
      platformArtifactManifests: normalizedPlatformArtifactManifests.map((manifest) => ({
        path: manifest.path,
        sha256: manifest.sha256,
        platform: manifest.platform,
        artifactName: manifest.artifactName,
      })),
      distTagPromotionEvidence: normalizedDistTagPromotionEvidence?.path || "",
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
  impactJson = "",
  buildSummaryJson = "",
  platformManifestJsons = [],
  distTagEvidenceJson = "",
  releaseJsonExtra = "",
  publishJson = "",
  workflow = {},
} = {}) {
  const release = parseJsonInput(releaseJson, {});
  const releaseExtra = parseJsonInput(releaseJsonExtra, {});
  const assetsFromJson = parseJsonInput(assetsJson, []);
  const packageSet = parseJsonInput(packageSetJson, undefined);
  const publishEvidenceMeta = parseJsonInputWithMeta(publishEvidenceJson, undefined);
  const trustedPublishing = parseJsonInput(trustedPublishingJson, undefined);
  const transactionMeta = parseJsonInputWithMeta(transactionJson, undefined);
  const anchorManifest = normalizeAnchorManifest(parseJsonInputWithMeta(anchorManifestJson, undefined));
  const impactMeta = parseJsonInputWithMeta(impactJson, undefined);
  const buildSummaryMeta = parseJsonInputWithMeta(buildSummaryJson, undefined);
  const platformManifestMetas = (platformManifestJsons || [])
    .filter(Boolean)
    .map((manifestJson) => parseJsonInputWithMeta(manifestJson, undefined));
  const distTagEvidenceMeta = parseJsonInputWithMeta(distTagEvidenceJson, undefined);
  const publish = parseJsonInput(publishJson, {});
  const assets = [
    ...(Array.isArray(release.assets) ? release.assets : []),
    ...(Array.isArray(assetsFromJson) ? assetsFromJson : []),
    ...discoverAssetsFromDir(assetsDir),
  ];
  const resolvedTag = tag || release.tag_name || release.name || "";
  const resolvedOutputDir = path.resolve(cwd, outputDir);
  const productMechanism = defaultProductMechanism({ repository, productName });
  const artifactEvidence = createArtifactEvidence({ assets, repository, tag: resolvedTag, sourceSha, workflow });
  const impact = normalizeImpactLedger(impactMeta.value, { tag: resolvedTag, line, decision: "unknown" });
  const agentIndex = defaultAgentIndex({ tag: resolvedTag });
  const passport = createReleasePassport({
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
    publishEvidence: publishEvidenceMeta.value,
    trustedPublishing,
    transaction: transactionMeta.value,
    buildSummary: buildSummaryMeta.value
      ? {
          ...buildSummaryMeta,
          path: buildSummaryMeta.path ? path.relative(resolvedOutputDir, buildSummaryMeta.path).split(path.sep).join("/") : "",
        }
      : undefined,
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
    publishEvidencePath: publishEvidenceMeta.path ? path.relative(resolvedOutputDir, publishEvidenceMeta.path).split(path.sep).join("/") : "",
    transactionStatePath: transactionMeta.path ? path.relative(resolvedOutputDir, transactionMeta.path).split(path.sep).join("/") : "",
    workflow,
  });
  const checkReport = createReleaseCheckReport({
    passport,
    artifactEvidence,
    publishEvidence: publishEvidenceMeta.value,
    impact,
    agentIndex,
    productMechanism,
    checkedAt: nowIso(),
  });
  const files = {
    "product-mechanism.json": productMechanism,
    "artifact-evidence.json": artifactEvidence,
    "impact.json": impact,
    "agent-index.json": agentIndex,
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
    files: Object.keys(files).concat("llms.txt"),
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

function resolveSiblingJson(basePath, relativePath) {
  if (!basePath || !relativePath || /^https?:\/\//.test(relativePath)) {
    return undefined;
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

export function createReleaseCheckReport({
  passport,
  artifactEvidence,
  publishEvidence,
  impact,
  agentIndex,
  productMechanism,
  checkedAt = nowIso(),
} = {}) {
  const issues = [];
  validateContract(passport, RELEASE_PASSPORT_CONTRACT, "passport", issues);
  validateContract(artifactEvidence, ARTIFACT_EVIDENCE_CONTRACT, "artifactEvidence", issues);
  validateContract(impact, IMPACT_LEDGER_CONTRACT, "impact", issues);
  validateContract(agentIndex, AGENT_INDEX_CONTRACT, "agentIndex", issues);
  validateContract(productMechanism, PRODUCT_MECHANISM_CONTRACT, "productMechanism", issues);

  const tag = passport?.release?.tag || "";
  if (!tag) {
    issues.push(issue("error", "release.tag", "release.tag is required"));
  }
  if (!passport?.release?.sourceSha) {
    issues.push(issue("warning", "release.sourceSha", "release.sourceSha is recommended"));
  }
  const artifacts = Array.isArray(passport?.artifacts) ? passport.artifacts : [];
  const normalizedPublishEvidence = normalizePublishEvidence(publishEvidence);
  const publishEvidenceSupplied =
    Boolean(passport?.evidence?.publishEvidence) ||
    (publishEvidence && typeof publishEvidence === "object" && Object.keys(publishEvidence).length > 0);
  const evidenceArtifacts = [
    ...(Array.isArray(artifactEvidence?.artifacts) ? artifactEvidence.artifacts : []),
    ...(normalizedPublishEvidence?.artifacts || []),
  ];
  if (publishEvidenceSupplied || passport?.packageSet) {
    const checkPublishField = (value, label) => {
      if (!value) {
        issues.push(issue("error", `publishEvidence.${label}`, `publishEvidence.${label} is required`));
      }
    };
    if (Number(normalizedPublishEvidence?.schema) !== 1) {
      issues.push(issue("error", "publishEvidence.schema", "publishEvidence.schema must be 1"));
    }
    checkPublishField(normalizedPublishEvidence?.version, "version");
    checkPublishField(normalizedPublishEvidence?.channel, "channel");
    checkPublishField(normalizedPublishEvidence?.sourceSha, "sourceSha");
    checkPublishField(normalizedPublishEvidence?.releaseSha, "releaseSha");
    checkPublishField(normalizedPublishEvidence?.targetRef, "targetRef");
    checkPublishField(normalizedPublishEvidence?.releaseMaterialSha, "releaseMaterialSha");
    checkPublishField(normalizedPublishEvidence?.publishToolingSha, "publishToolingSha");
    if (!Array.isArray(normalizedPublishEvidence?.artifacts) || normalizedPublishEvidence.artifacts.length === 0) {
      issues.push(issue("error", "publishEvidence.artifacts", "publishEvidence.artifacts must include published artifacts"));
    }
    if (passport?.release?.sourceSha && normalizedPublishEvidence?.sourceSha && passport.release.sourceSha !== normalizedPublishEvidence.sourceSha) {
      issues.push(issue("error", "publishEvidence.sourceSha.mismatch", "publishEvidence.sourceSha must match passport.release.sourceSha"));
    }
    if (passport?.release?.releaseSha && normalizedPublishEvidence?.releaseSha && passport.release.releaseSha !== normalizedPublishEvidence.releaseSha) {
      issues.push(issue("error", "publishEvidence.releaseSha.mismatch", "publishEvidence.releaseSha must match passport.release.releaseSha"));
    }
    if (passport?.release?.targetRef && normalizedPublishEvidence?.targetRef && passport.release.targetRef !== normalizedPublishEvidence.targetRef) {
      issues.push(issue("error", "publishEvidence.targetRef.mismatch", "publishEvidence.targetRef must match passport.release.targetRef"));
    }
  }
  if (artifacts.length === 0) {
    issues.push(issue("error", "artifacts.empty", "release passport must list at least one artifact"));
  }
  const evidenceIndex = indexEvidenceArtifacts(evidenceArtifacts);
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
  }
  if (passport?.packageSet) {
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
    if (!passport.transaction.exactTag) {
      issues.push(issue("error", "transaction.exactTag", "transaction.exactTag is required"));
    }
    if (!passport.transaction.releaseSha) {
      issues.push(issue("error", "transaction.releaseSha", "transaction.releaseSha is required"));
    }
    if (!passport.transaction.releaseMaterialSha) {
      issues.push(issue("error", "transaction.releaseMaterialSha", "transaction.releaseMaterialSha is required"));
    }
    if (!passport.transaction.stateRef) {
      issues.push(issue("error", "transaction.stateRef", "transaction.stateRef is required"));
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
  const surfaceImpacts = Array.isArray(impact?.surfaceImpacts) ? impact.surfaceImpacts : [];
  const passportSurfaceImpacts = Array.isArray(passport?.surfaceImpacts) ? passport.surfaceImpacts : [];
  const declaredFinalImpact = normalizeImpactLevel(impact?.versionImpact?.final || impact?.classification);
  const computedFinalImpact = highestImpactLevel(surfaceImpacts.map((entry) => entry.impact));
  const requiredSurfaceImpacts = surfaceImpactRequirement({ passport, impact });
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
    },
    issues,
  };
}

export async function readJsonFromLocation(location) {
  const input = nonEmptyString(location, "location");
  if (/^https?:\/\//.test(input)) {
    const client = input.startsWith("https:") ? https : http;
    return new Promise((resolve, reject) => {
      client
        .get(input, (response) => {
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
        })
        .on("error", reject);
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
} = {}) {
  const passport = await readJsonFromLocation(passportLocation);
  const basePath = /^https?:\/\//.test(passportLocation) ? "" : path.resolve(passportLocation);
  const artifactEvidence =
    artifactEvidenceLocation
      ? await readJsonFromLocation(artifactEvidenceLocation)
      : resolveSiblingJson(basePath, passport.evidence?.artifactEvidence) || {};
  const publishEvidence =
    publishEvidenceLocation
      ? await readJsonFromLocation(publishEvidenceLocation)
      : resolveSiblingJson(basePath, passport.evidence?.publishEvidence) || {};
  const impact =
    impactLocation
      ? await readJsonFromLocation(impactLocation)
      : resolveSiblingJson(basePath, passport.evidence?.impact) || {};
  const agentIndex =
    agentIndexLocation
      ? await readJsonFromLocation(agentIndexLocation)
      : resolveSiblingJson(basePath, passport.evidence?.agentIndex) || {};
  const productMechanism =
    productMechanismLocation
      ? await readJsonFromLocation(productMechanismLocation)
      : resolveSiblingJson(basePath, passport.product?.mechanism) || {};
  return createReleaseCheckReport({
    passport,
    artifactEvidence,
    publishEvidence,
    impact,
    agentIndex,
    productMechanism,
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
