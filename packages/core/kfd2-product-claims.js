import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  BUILDCHAIN_KFD2_CLAIMS_DIR,
  BUILDCHAIN_KFD2_CLAIM_ARGS_PATH,
  BUILDCHAIN_KFD2_DIR,
  BUILDCHAIN_KFD2_REGISTRY_PATH,
  BUILDCHAIN_KFD2_RELEASE_CLAIMS_PATH,
  toPosixPath,
} from "./buildchain-layout.js";
import {
  discoverConfiguredVersionStateFiles,
  loadBuildchainConfig,
} from "./buildchain-config.js";

export const KFD2_PRODUCT_CLAIMS_REGISTRY_CONTRACT =
  "kungfu-buildchain-kfd-2-product-claims-registry/v1";
export const KFD2_PRODUCT_CLAIMS_VALIDATION_CONTRACT =
  "kungfu-buildchain-kfd-2-product-claims-registry-validation";
export const KFD2_PRODUCT_CLAIMS_OUTPUT_CONTRACT =
  "kungfu-buildchain-kfd-2-product-claims-output";

const CLAIM_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CLAIM_STATUSES = new Set([
  "declared",
  "audited",
  "enforced",
  "not-applicable",
]);
const ENUMERABILITY = new Set([
  "closed-world",
  "declared-open",
  "sampled",
  "manual",
]);

function issue(code, message, pathValue = "") {
  return {
    level: "error",
    code,
    message,
    ...(pathValue ? { path: pathValue } : {}),
  };
}

function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveRepoPath(cwd, relativePath, label = "path") {
  if (!relativePath || typeof relativePath !== "string") {
    throw new Error(`${label} must be a repository-relative path`);
  }
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes repository root: ${relativePath}`);
  }
  return resolved;
}

function repoRelative(cwd, filePath) {
  return toPosixPath(path.relative(path.resolve(cwd), path.resolve(filePath)));
}

function gitHead(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function dottedValue(value, key) {
  return String(key || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, part) => current?.[part], value);
}

function configuredVersion(cwd) {
  const loaded = loadBuildchainConfig(cwd);
  const files = discoverConfiguredVersionStateFiles(cwd, loaded);
  const versions = files.map((file) => {
    if (file.type === "json" || file.type === "toml") {
      return dottedValue(file.content, file.key);
    }
    return file.source.match(file.pattern)?.groups?.version || "";
  }).filter(Boolean);
  if (new Set(versions).size > 1) {
    throw new Error(`configured version files disagree: ${versions.join(", ")}`);
  }
  if (versions.length > 0) return versions[0];
  for (const candidate of ["package.json", "lerna.json"]) {
    const candidatePath = path.join(cwd, candidate);
    if (!fs.existsSync(candidatePath)) continue;
    const value = readJsonFile(candidatePath).version;
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function pointerFor(cwd, input, label) {
  const filePath = resolveRepoPath(cwd, input?.path, label);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} does not name a readable file: ${input?.path || ""}`);
  }
  return {
    kind: input.kind || "file",
    path: repoRelative(cwd, filePath),
    sha256: sha256File(filePath),
    ...(input.schemaId ? { schemaId: input.schemaId } : {}),
    ...(input.digest ? { digest: input.digest } : {}),
    ...(input.specifier ? { specifier: input.specifier } : {}),
  };
}

export function readKfd2ProductClaimsRegistry({
  cwd = process.cwd(),
  registryPath = BUILDCHAIN_KFD2_REGISTRY_PATH,
} = {}) {
  const resolvedPath = resolveRepoPath(cwd, registryPath, "registryPath");
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`KFD-2 product claims registry not found: ${registryPath}`);
  }
  return {
    path: repoRelative(cwd, resolvedPath),
    sha256: sha256File(resolvedPath),
    registry: readJsonFile(resolvedPath),
  };
}

export function validateKfd2ProductClaimsRegistry(registry = {}) {
  const issues = [];
  if (registry?.schema !== KFD2_PRODUCT_CLAIMS_REGISTRY_CONTRACT) {
    issues.push(issue(
      "kfd-2.product-registry.schema",
      `registry.schema must be ${KFD2_PRODUCT_CLAIMS_REGISTRY_CONTRACT}`,
      "schema",
    ));
  }
  if (registry?.kfd?.standard !== "kfd-2") {
    issues.push(issue("kfd-2.product-registry.standard", "registry.kfd.standard must be kfd-2", "kfd.standard"));
  }
  if (registry?.kfd?.contract !== "kfd-2-release-claims") {
    issues.push(issue(
      "kfd-2.product-registry.contract",
      "registry.kfd.contract must be kfd-2-release-claims",
      "kfd.contract",
    ));
  }
  if (!registry?.product?.name) {
    issues.push(issue("kfd-2.product-registry.product", "registry.product.name is required", "product.name"));
  }
  const claims = Array.isArray(registry?.claims) ? registry.claims : [];
  if (claims.length === 0) {
    issues.push(issue("kfd-2.product-registry.claims", "registry.claims must be a non-empty array", "claims"));
  }
  const ids = new Set();
  for (const [index, claim] of claims.entries()) {
    const label = `claims[${index}]`;
    if (!CLAIM_ID_RE.test(String(claim?.id || ""))) {
      issues.push(issue("kfd-2.product-registry.claim-id", `${label}.id must match ${CLAIM_ID_RE}`, `${label}.id`));
    } else if (ids.has(claim.id)) {
      issues.push(issue("kfd-2.product-registry.duplicate-claim", `${label}.id duplicates ${claim.id}`, `${label}.id`));
    }
    ids.add(claim?.id);
    if (!claim?.statement) issues.push(issue("kfd-2.product-registry.statement", `${label}.statement is required`, `${label}.statement`));
    if (!claim?.source?.path) issues.push(issue("kfd-2.product-registry.source", `${label}.source.path is required`, `${label}.source.path`));
    if (!Array.isArray(claim?.evidence) || claim.evidence.length === 0) {
      issues.push(issue("kfd-2.product-registry.evidence", `${label}.evidence must be non-empty`, `${label}.evidence`));
    }
    if (!Array.isArray(claim?.artifacts) || claim.artifacts.length === 0) {
      issues.push(issue("kfd-2.product-registry.artifacts", `${label}.artifacts must be non-empty`, `${label}.artifacts`));
    }
    if (!claim?.auditBoundary?.scope) {
      issues.push(issue("kfd-2.product-registry.audit-boundary", `${label}.auditBoundary.scope is required`, `${label}.auditBoundary.scope`));
    }
    if (!ENUMERABILITY.has(String(claim?.auditBoundary?.enumerability || ""))) {
      issues.push(issue("kfd-2.product-registry.enumerability", `${label}.auditBoundary.enumerability is invalid`, `${label}.auditBoundary.enumerability`));
    }
    if (!Array.isArray(claim?.residualRisk)) {
      issues.push(issue("kfd-2.product-registry.residual-risk", `${label}.residualRisk must be an array`, `${label}.residualRisk`));
    }
    for (const key of ["sourceOwner", "verificationOwner", "releaseDecisionOwner"]) {
      if (!claim?.responsibility?.[key]) {
        issues.push(issue("kfd-2.product-registry.responsibility", `${label}.responsibility.${key} is required`, `${label}.responsibility.${key}`));
      }
    }
    if (!CLAIM_STATUSES.has(String(claim?.status || ""))) {
      issues.push(issue("kfd-2.product-registry.status", `${label}.status is invalid`, `${label}.status`));
    }
  }
  return {
    schemaVersion: 1,
    contract: KFD2_PRODUCT_CLAIMS_VALIDATION_CONTRACT,
    ok: issues.length === 0,
    claimCount: claims.length,
    issues,
  };
}

function assertValidRegistry(registry) {
  const validation = validateKfd2ProductClaimsRegistry(registry);
  if (!validation.ok) {
    throw new Error(`KFD-2 product claims registry is invalid:\n${validation.issues.map((entry) => `- ${entry.path || entry.code}: ${entry.message}`).join("\n")}`);
  }
  return validation;
}

function canonicalClaim(cwd, claim, defaultCheckCommand) {
  const source = pointerFor(cwd, claim.source, `${claim.id}.source`);
  return {
    id: claim.id,
    statement: claim.statement,
    category: claim.category || "kfd-2",
    source,
    evidence: claim.evidence.map((entry, index) => ({
      type: entry.type || "file",
      pointer: pointerFor(cwd, { ...entry, kind: entry.kind || "file" }, `${claim.id}.evidence[${index}]`),
      description: entry.description || "",
    })),
    verification: {
      command: claim.verification?.command || defaultCheckCommand,
      expectedResult: claim.verification?.expectedResult || "pass",
    },
    auditBoundary: {
      scope: claim.auditBoundary.scope,
      enumerability: claim.auditBoundary.enumerability,
      exclusions: claim.auditBoundary.exclusions || [],
    },
    residualRisk: claim.residualRisk,
    responsibility: claim.responsibility,
    status: claim.status,
  };
}

function passportClaim(cwd, claim, registrySha256, defaultCheckCommand) {
  const source = pointerFor(cwd, claim.source, `${claim.id}.source`);
  const machineEvidence = claim.evidence.map((entry, index) => ({
    type: entry.type || "file",
    pointer: pointerFor(cwd, { ...entry, kind: entry.kind || "file" }, `${claim.id}.evidence[${index}]`),
    description: entry.description || "",
  }));
  const artifacts = claim.artifacts.map((artifact, index) => {
    const pointer = pointerFor(cwd, { kind: "file", path: artifact.path }, `${claim.id}.artifacts[${index}]`);
    return {
      name: artifact.name || path.basename(artifact.path),
      path: pointer.path,
      sha256: pointer.sha256,
      expectedPackagePath: artifact.expectedPackagePath || "",
    };
  });
  return {
    id: claim.id,
    public: true,
    claim: claim.statement,
    sourceBindings: [{
      role: "claim-source",
      kind: source.kind,
      path: source.path,
      sha256: source.sha256,
    }],
    machineEvidence,
    hashes: {
      registrySha256,
      sourceSha256: source.sha256,
      evidenceSha256: machineEvidence.map((entry) => ({
        path: entry.pointer.path,
        sha256: entry.pointer.sha256,
      })),
      artifactSha256: artifacts.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    },
    artifacts,
    verification: {
      result: claim.residualRisk.length === 0 ? "passed" : "passed-with-residual-risk",
      command: claim.verification?.command || defaultCheckCommand,
      expectedResult: claim.verification?.expectedResult || "pass",
    },
    auditBoundary: {
      scope: claim.auditBoundary.scope,
      enumerability: claim.auditBoundary.enumerability,
      exclusions: claim.auditBoundary.exclusions || [],
    },
    responsibility: claim.responsibility,
    residualRisk: claim.residualRisk,
    canonicalStatus: claim.status,
  };
}

function outputPaths(cwd, outputDir, claimIds) {
  const resolvedOutputDir = resolveRepoPath(cwd, outputDir, "outputDir");
  return {
    outputDir: resolvedOutputDir,
    releaseClaims: path.join(resolvedOutputDir, path.basename(BUILDCHAIN_KFD2_RELEASE_CLAIMS_PATH)),
    claimArgs: path.join(resolvedOutputDir, path.basename(BUILDCHAIN_KFD2_CLAIM_ARGS_PATH)),
    claimsDir: path.join(resolvedOutputDir, path.basename(BUILDCHAIN_KFD2_CLAIMS_DIR)),
    claims: claimIds.map((id) => path.join(resolvedOutputDir, path.basename(BUILDCHAIN_KFD2_CLAIMS_DIR), `${id}.json`)),
  };
}

export function renderKfd2ProductClaimOutputs({
  cwd = process.cwd(),
  registryPath = BUILDCHAIN_KFD2_REGISTRY_PATH,
  outputDir = BUILDCHAIN_KFD2_DIR,
  version = "",
  channel = "",
  tag = "",
  sourceSha = "",
} = {}) {
  const source = readKfd2ProductClaimsRegistry({ cwd, registryPath });
  const validation = assertValidRegistry(source.registry);
  const releaseVersion = version || source.registry.releaseDefaults?.version || configuredVersion(cwd);
  if (!releaseVersion) throw new Error("KFD-2 product claims require a release version");
  const defaultCheckCommand = source.registry.buildchain?.checkCommand || "buildchain kfd 2 product-claims check";
  const releaseClaims = {
    schemaVersion: 1,
    contract: source.registry.kfd.contract,
    standard: source.registry.kfd.standard,
    product: source.registry.product,
    release: {
      version: releaseVersion,
      channel: channel || source.registry.releaseDefaults?.channel || "local",
      tag: tag || `${source.registry.releaseDefaults?.tagPrefix || "v"}${releaseVersion}`,
      sourceSha: sourceSha || source.registry.releaseDefaults?.sourceSha || gitHead(cwd) || "unknown",
    },
    claims: source.registry.claims.map((claim) => canonicalClaim(cwd, claim, defaultCheckCommand)),
    schemaEvolution: {
      interfaceVersion: source.registry.kfd.interfaceVersion || 1,
      compatibilityRule: "Compatible additions may keep schemaVersion 1; required-field or semantic changes require a new KFD-owned interface version.",
    },
  };
  const claims = source.registry.claims.map((claim) => passportClaim(
    cwd,
    claim,
    source.sha256,
    defaultCheckCommand,
  ));
  const paths = outputPaths(cwd, outputDir, claims.map((claim) => claim.id));
  const claimArgs = `${paths.claims.map((claimPath) => `--kfd-2-claim-json ${repoRelative(cwd, claimPath)}`).join("\n")}\n`;
  const files = [
    { path: repoRelative(cwd, paths.releaseClaims), content: renderJson(releaseClaims) },
    ...claims.map((claim, index) => ({ path: repoRelative(cwd, paths.claims[index]), content: renderJson(claim) })),
    { path: repoRelative(cwd, paths.claimArgs), content: claimArgs },
  ];
  return {
    schemaVersion: 1,
    contract: KFD2_PRODUCT_CLAIMS_OUTPUT_CONTRACT,
    ok: true,
    registry: {
      path: source.path,
      sha256: source.sha256,
      contract: source.registry.schema,
    },
    validation,
    releaseClaims,
    claims,
    outputDir: repoRelative(cwd, paths.outputDir),
    files,
    summary: {
      claimCount: claims.length,
      releaseClaimsSha256: sha256Buffer(Buffer.from(renderJson(releaseClaims))),
      passportClaimStatuses: claims.map((claim) => ({
        id: claim.id,
        status: claim.residualRisk.length === 0 ? "passed" : "downgraded",
        residualRisk: claim.residualRisk.length,
      })),
    },
  };
}

function compareOutputs(cwd, rendered) {
  const issues = [];
  const expectedPaths = new Set(rendered.files.map((entry) => entry.path));
  for (const entry of rendered.files) {
    const filePath = resolveRepoPath(cwd, entry.path, "output path");
    if (!fs.existsSync(filePath)) {
      issues.push(issue("kfd-2.product-output.missing", `missing generated output: ${entry.path}`, entry.path));
    } else if (fs.readFileSync(filePath, "utf8") !== entry.content) {
      issues.push(issue("kfd-2.product-output.drift", `generated output is stale: ${entry.path}`, entry.path));
    }
  }
  const claimsDir = resolveRepoPath(cwd, path.join(rendered.outputDir, "claims"), "claims directory");
  if (fs.existsSync(claimsDir)) {
    for (const entry of fs.readdirSync(claimsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const relativePath = repoRelative(cwd, path.join(claimsDir, entry.name));
      if (!expectedPaths.has(relativePath)) {
        issues.push(issue("kfd-2.product-output.unexpected", `unexpected generated claim: ${relativePath}`, relativePath));
      }
    }
  }
  return issues;
}

export function checkKfd2ProductClaimOutputs(options = {}) {
  const rendered = renderKfd2ProductClaimOutputs(options);
  const issues = compareOutputs(path.resolve(options.cwd || process.cwd()), rendered);
  return {
    ...rendered,
    ok: issues.length === 0,
    status: issues.length === 0 ? "current" : "mismatched",
    issues,
  };
}

export function writeKfd2ProductClaimOutputs(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const rendered = renderKfd2ProductClaimOutputs({ ...options, cwd });
  for (const entry of rendered.files) {
    const filePath = resolveRepoPath(cwd, entry.path, "output path");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, entry.content);
  }
  const expectedPaths = new Set(rendered.files.map((entry) => entry.path));
  const claimsDir = resolveRepoPath(cwd, path.join(rendered.outputDir, "claims"), "claims directory");
  const removed = [];
  if (fs.existsSync(claimsDir)) {
    for (const entry of fs.readdirSync(claimsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(claimsDir, entry.name);
      const relativePath = repoRelative(cwd, filePath);
      if (!expectedPaths.has(relativePath)) {
        fs.unlinkSync(filePath);
        removed.push(relativePath);
      }
    }
  }
  return {
    ...rendered,
    status: "written",
    written: rendered.files.map((entry) => entry.path),
    removed,
  };
}
