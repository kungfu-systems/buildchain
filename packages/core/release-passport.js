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
  return {
    schemaVersion: 1,
    contract: IMPACT_LEDGER_CONTRACT,
    release: { tag, line },
    classification: decision,
    breaking: false,
    security: false,
    migrationRequired: false,
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
  packageName = "@kungfu-tech/buildchain",
  packageVersion = "",
  productMechanismPath = "product-mechanism.json",
  artifactEvidencePath = "artifact-evidence.json",
  impactPath = "impact.json",
  agentIndexPath = "agent-index.json",
  checkReportPath = "check-report.json",
  assets = [],
  workflow = {},
} = {}) {
  const normalizedTag = nonEmptyString(tag, "tag");
  const artifactEvidence = createArtifactEvidence({ assets, repository, tag: normalizedTag, sourceSha, workflow });
  return {
    schemaVersion: 1,
    contract: RELEASE_PASSPORT_CONTRACT,
    generatedAt: nowIso(),
    product: {
      name: "Buildchain",
      repository: optionalString(repository),
      mechanism: productMechanismPath,
    },
    release: {
      tag: normalizedTag,
      line: optionalString(line),
      sourceSha: optionalString(sourceSha),
      package: {
        name: packageName,
        version: packageVersion || readPackageVersion(cwd),
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
    artifacts: artifactEvidence.artifacts.map((asset) => ({
      name: asset.name,
      platform: asset.platform,
      sha256: asset.sha256,
      evidence: artifactEvidencePath,
      url: asset.url,
    })),
    evidence: {
      artifactEvidence: artifactEvidencePath,
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
  workflow = {},
} = {}) {
  const release = parseJsonInput(releaseJson, {});
  const assetsFromJson = parseJsonInput(assetsJson, []);
  const assets = [
    ...(Array.isArray(release.assets) ? release.assets : []),
    ...(Array.isArray(assetsFromJson) ? assetsFromJson : []),
    ...discoverAssetsFromDir(assetsDir),
  ];
  const resolvedTag = tag || release.tag_name || release.name || "";
  const resolvedOutputDir = path.resolve(cwd, outputDir);
  const productMechanism = defaultProductMechanism({ repository, productName });
  const artifactEvidence = createArtifactEvidence({ assets, repository, tag: resolvedTag, sourceSha, workflow });
  const impact = defaultImpact({ tag: resolvedTag, line, decision: "unknown" });
  const agentIndex = defaultAgentIndex({ tag: resolvedTag });
  const passport = createReleasePassport({
    cwd,
    repository,
    tag: resolvedTag,
    sourceSha,
    line,
    packageName,
    packageVersion,
    assets,
    workflow,
  });
  const checkReport = createReleaseCheckReport({
    passport,
    artifactEvidence,
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

export function createReleaseCheckReport({
  passport,
  artifactEvidence,
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
  const evidenceArtifacts = Array.isArray(artifactEvidence?.artifacts) ? artifactEvidence.artifacts : [];
  if (artifacts.length === 0) {
    issues.push(issue("error", "artifacts.empty", "release passport must list at least one artifact"));
  }
  const evidenceByName = new Map(evidenceArtifacts.map((artifact) => [artifact.name, artifact]));
  for (const artifact of artifacts) {
    if (!artifact.name) {
      issues.push(issue("error", "artifact.name", "artifact name is required"));
      continue;
    }
    const evidence = evidenceByName.get(artifact.name);
    if (!evidence) {
      issues.push(issue("error", "artifact.evidence.missing", `artifact ${artifact.name} is missing evidence`));
      continue;
    }
    if (!/^[0-9a-f]{64}$/i.test(String(evidence.sha256 || ""))) {
      issues.push(issue("error", "artifact.sha256", `artifact ${artifact.name} must have a sha256 digest`));
    }
    if (artifact.sha256 && evidence.sha256 && artifact.sha256 !== evidence.sha256) {
      issues.push(issue("error", "artifact.sha256.mismatch", `artifact ${artifact.name} digest differs between passport and evidence`));
    }
  }
  if (!passport?.runnerPolicy?.productionDefault) {
    issues.push(issue("warning", "runnerPolicy.productionDefault", "runner policy should record the production default"));
  }
  const ok = issues.every((entry) => entry.level !== "error");
  return {
    schemaVersion: 1,
    contract: RELEASE_CHECK_REPORT_CONTRACT,
    checkedAt,
    ok,
    trust: ok ? "pass" : "fail",
    completeness: {
      artifactCount: artifacts.length,
      evidenceArtifactCount: evidenceArtifacts.length,
      impactPresent: Boolean(impact),
      agentIndexPresent: Boolean(agentIndex),
      productMechanismPresent: Boolean(productMechanism),
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
      breaking: false,
      migrationRequired: false,
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
