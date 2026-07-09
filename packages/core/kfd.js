import fs from "node:fs";
import { createRequire } from "node:module";
import crypto from "node:crypto";
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
import { loadBuildchainConfig } from "./buildchain-config.js";

const require = createRequire(import.meta.url);
const KFD_UPSTREAM_AGGREGATE_CONTRACT = "kungfu-buildchain-kfd-upstream-aggregate";
const KFD_AGGREGATE_CONTRACT = "kungfu-buildchain-kfd-aggregate";
const KFD_UPSTREAM_CHECK_CONTRACT = "kungfu-buildchain-kfd-upstream-check";
const KFD_UPSTREAM_ROLES = Object.freeze({
  STANDARD_AND_SCHEMA_PROVIDER: "standard-and-schema-provider",
  RELEASE_PASSPORT_AND_KFD_GATE_PROVIDER: "release-passport-and-kfd-gate-provider",
  KFD_AWARE_PRODUCT_COMPONENT: "kfd-aware-product-component",
  SITE_CONSUMPTION_PROVIDER: "site-consumption-provider",
  UNKNOWN_KFD_UPSTREAM: "unknown-kfd-upstream",
});
const KFD_UPSTREAM_ROLE_SET = new Set(Object.values(KFD_UPSTREAM_ROLES));
const KFD_UPSTREAM_KNOWN_PACKAGE_ROLES = Object.freeze({
  "@kungfu-tech/kfd": KFD_UPSTREAM_ROLES.STANDARD_AND_SCHEMA_PROVIDER,
  "@kungfu-tech/buildchain": KFD_UPSTREAM_ROLES.RELEASE_PASSPORT_AND_KFD_GATE_PROVIDER,
});
const KFD_UPSTREAM_ROLE_DEFINITIONS = Object.freeze([
  {
    role: KFD_UPSTREAM_ROLES.STANDARD_AND_SCHEMA_PROVIDER,
    description: "Provides KFD standards, schemas, taxonomy, or standard-owned witness and claim facts.",
  },
  {
    role: KFD_UPSTREAM_ROLES.RELEASE_PASSPORT_AND_KFD_GATE_PROVIDER,
    description: "Provides release passport, KFD gate, release claim, or release governance machinery consumed by the product.",
  },
  {
    role: KFD_UPSTREAM_ROLES.KFD_AWARE_PRODUCT_COMPONENT,
    description: "A product component that exposes KFD witness, claim, collaboration-interface, or package evidence without being core KFD infrastructure.",
  },
  {
    role: KFD_UPSTREAM_ROLES.SITE_CONSUMPTION_PROVIDER,
    description: "Provides site-consumption facts such as site manifests, site bundles, or downstream page-content contracts.",
  },
  {
    role: KFD_UPSTREAM_ROLES.UNKNOWN_KFD_UPSTREAM,
    description: "Fallback for a declared upstream that has not matched a Buildchain-known package or role-specific evidence.",
  },
]);
const KFD_UPSTREAM_DEFAULT_EVIDENCE = Object.freeze([
  { kind: "package", path: "buildchain.release.json", required: false },
  { kind: "package", path: "kfd.release.json", required: false },
  { kind: "package", path: "libnode.release.json", required: false },
  { kind: "package", path: "standards.json", required: false },
  { kind: "package", path: ".buildchain/kfd/kfd-1/contract-world.witness.json", required: false },
  { kind: "package", path: ".buildchain/kfd/kfd-2/release-claims.json", required: false },
  { kind: "package", path: ".buildchain/kfd/kfd-2/claims", required: false },
  { kind: "package", path: ".buildchain/kfd/kfd-3/collaboration-interface.json", required: false },
  { kind: "package", path: ".buildchain/kfd/kfd-3/collaboration-interface.prebuild.json", required: false },
  { kind: "package", path: ".buildchain/kfd/kfd-3/collaboration-interface.artifact.json", required: false },
  { kind: "package", path: ".buildchain/kfd-1/contract-world.witness.json", required: false },
  { kind: "package", path: ".buildchain/kfd-2/public-release-trust.claim.json", required: false },
  { kind: "package", path: ".buildchain/kfd-2/kfd-foundation.trust-claims.json", required: false },
  { kind: "package", path: ".buildchain/kfd-2/kfd-foundation.trust-assessment.json", required: false },
  { kind: "package", path: ".buildchain/kfd-3/collaboration-interface.json", required: false },
  { kind: "package", path: "dist/site/kfd-claims.json", required: false },
]);

function readJsonPackageExport(exportPath) {
  return JSON.parse(fs.readFileSync(require.resolve(exportPath), "utf8"));
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function posixPath(value) {
  return String(value || "").split(path.sep).join("/");
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

function fileDigest(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile()) files.push(child);
      }
    };
    walk(filePath);
    const relativeFiles = files
      .map((file) => ({ file, relativePath: posixPath(path.relative(filePath, file)) }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const hash = crypto.createHash("sha256");
    for (const { file, relativePath } of relativeFiles) {
      hash.update(relativePath);
      hash.update("\0");
      hash.update(fs.readFileSync(file));
      hash.update("\0");
    }
    return hash.digest("hex");
  }
  return sha256Buffer(fs.readFileSync(filePath));
}

function readJsonIfFile(filePath) {
  if (!filePath.endsWith(".json")) return undefined;
  try {
    return readJsonFile(filePath);
  } catch {
    return undefined;
  }
}

function packageRequire(cwd) {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const packagePath = path.join(resolvedCwd, "package.json");
  return createRequire(fs.existsSync(packagePath) ? packagePath : path.join(resolvedCwd, "noop.js"));
}

function readLocalPackage(cwd) {
  const packagePath = path.join(path.resolve(cwd), "package.json");
  return fs.existsSync(packagePath) ? readJsonFile(packagePath) : {};
}

function resolvePackage({ packageName, cwd }) {
  const req = packageRequire(cwd);
  const packageJsonPath = req.resolve(`${packageName}/package.json`);
  const packageJson = readJsonFile(packageJsonPath);
  return {
    name: packageJson.name || packageName,
    version: packageJson.version || "",
    repository: typeof packageJson.repository === "string" ? packageJson.repository : packageJson.repository?.url || "",
    packageJsonPath,
    packageRoot: path.dirname(packageJsonPath),
    packageJson,
  };
}

function parseEvidenceSpec(spec) {
  if (typeof spec === "string") {
    const [kind, ...rest] = spec.includes(":") ? spec.split(":") : ["package", spec];
    return {
      kind: kind || "package",
      path: rest.join(":"),
      required: true,
    };
  }
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    const kind = String(spec.kind || spec.type || "package");
    const rawPath = String(spec.path || spec.asset || spec.location || "");
    return {
      kind,
      path: rawPath.startsWith(`${kind}:`) ? rawPath.slice(kind.length + 1) : rawPath,
      required: spec.required === undefined ? true : Boolean(spec.required),
      contract: spec.contract === undefined ? "" : String(spec.contract),
      role: spec.role === undefined ? "" : String(spec.role),
    };
  }
  return { kind: "package", path: "", required: false };
}

function assetFromSpec({ spec, resolvedPackage, cwd }) {
  const parsed = parseEvidenceSpec(spec);
  if (!parsed.path) {
    return undefined;
  }
  const basePath = parsed.kind === "package"
    ? resolvedPackage.packageRoot
    : path.resolve(cwd);
  const filePath = path.resolve(basePath, parsed.path);
  if (!fs.existsSync(filePath)) {
    if (parsed.required) {
      return {
        path: parsed.kind === "package" ? parsed.path : posixPath(path.relative(cwd, filePath)),
        kind: parsed.kind,
        missing: true,
        required: true,
      };
    }
    return undefined;
  }
  const stat = fs.statSync(filePath);
  const parsedJson = stat.isFile() ? readJsonIfFile(filePath) : undefined;
  return {
    path: parsed.kind === "package" ? parsed.path : posixPath(path.relative(cwd, filePath)),
    kind: parsed.kind,
    sha256: `sha256:${fileDigest(filePath)}`,
    contract: parsed.contract || (parsedJson && typeof parsedJson === "object" ? parsedJson.contract || parsedJson.schema || "" : ""),
    role: parsed.role || "",
    directory: stat.isDirectory(),
    parsed: parsedJson,
  };
}

function normalizeKfdSupport(component = {}) {
  const support = component.kfd && typeof component.kfd === "object" && !Array.isArray(component.kfd)
    ? { ...component.kfd }
    : {};
  for (const [key, aliases] of Object.entries({
    kfd1: ["kfd1", "kfd_1", "kfd-1"],
    kfd2: ["kfd2", "kfd_2", "kfd-2"],
    kfd3: ["kfd3", "kfd_3", "kfd-3"],
    kfd4: ["kfd4", "kfd_4", "kfd-4"],
  })) {
    const found = aliases.map((alias) => component[alias] ?? support[alias]).find((value) => value !== undefined);
    support[key] = found === undefined ? support[key] || "declared" : String(found);
  }
  return support;
}

function normalizeKfdUpstreamComponent(component = {}, index = 0) {
  const packageName = component.package || component.packageName || component.npm || component.name;
  const explicitRole = component.role === undefined ? "" : String(component.role || "").trim();
  return {
    id: String(component.id || packageName || `upstream-${index + 1}`).replace(/^@/, "").replace(/[^a-zA-Z0-9_.-]+/g, "-"),
    explicitRole,
    packageName: packageName ? String(packageName) : "",
    repository: String(component.repository || ""),
    evidence: Array.isArray(component.evidence) ? component.evidence : [],
    releasePassport: String(component.release_passport || component.releasePassport || ""),
    kfd: normalizeKfdSupport(component),
    residualRisk: Array.isArray(component.residualRisk)
      ? component.residualRisk.map(String)
      : Array.isArray(component.residual_risk) ? component.residual_risk.map(String) : [],
  };
}

function configuredKfdUpstreamComponents(cwd) {
  const loaded = loadBuildchainConfig(cwd);
  const upstream = loaded?.config?.kfd?.upstream;
  if (!upstream || typeof upstream !== "object" || Array.isArray(upstream)) {
    return {
      configPath: loaded?.path || "",
      autoDiscover: false,
      components: [],
    };
  }
  return {
    configPath: loaded?.path || "",
    autoDiscover: upstream.auto_discover === undefined ? Boolean(upstream.autoDiscover) : Boolean(upstream.auto_discover),
    components: Array.isArray(upstream.components) ? upstream.components.map(normalizeKfdUpstreamComponent) : [],
  };
}

function dependencyMap(pkg) {
  return {
    ...(pkg.dependencies && typeof pkg.dependencies === "object" && !Array.isArray(pkg.dependencies) ? pkg.dependencies : {}),
    ...(pkg.devDependencies && typeof pkg.devDependencies === "object" && !Array.isArray(pkg.devDependencies) ? pkg.devDependencies : {}),
    ...(pkg.optionalDependencies && typeof pkg.optionalDependencies === "object" && !Array.isArray(pkg.optionalDependencies) ? pkg.optionalDependencies : {}),
  };
}

function autoDiscoveredKfdUpstreams(cwd) {
  const pkg = readLocalPackage(cwd);
  return Object.keys(dependencyMap(pkg))
    .filter((name) => name.startsWith("@kungfu-tech/"))
    .filter((name) => name !== pkg.name)
    .filter((name) => ["@kungfu-tech/kfd", "@kungfu-tech/buildchain", "@kungfu-tech/libnode"].includes(name))
    .map((name, index) => normalizeKfdUpstreamComponent({
      id: name.split("/").pop(),
      package: name,
      evidence: KFD_UPSTREAM_DEFAULT_EVIDENCE,
    }, index));
}

function inferKfdUpstreamRole({ component = {}, resolvedPackage = {}, assets = [] } = {}) {
  const explicitRole = String(component.explicitRole || "").trim();
  if (explicitRole) {
    return {
      role: explicitRole,
      roleSource: "explicit",
      roleReason: KFD_UPSTREAM_ROLE_SET.has(explicitRole)
        ? "Configured role is one of the Buildchain-managed KFD upstream roles."
        : `Configured role is not a Buildchain-managed KFD upstream role: ${explicitRole}`,
      roleValid: KFD_UPSTREAM_ROLE_SET.has(explicitRole),
    };
  }

  const packageName = resolvedPackage.name || component.packageName || "";
  const knownPackageRole = KFD_UPSTREAM_KNOWN_PACKAGE_ROLES[packageName];
  if (knownPackageRole) {
    return {
      role: knownPackageRole,
      roleSource: "known-package",
      roleReason: `${packageName} is a Buildchain-known KFD upstream package.`,
      roleValid: true,
    };
  }

  const assetList = Array.isArray(assets) ? assets : [];
  const contracts = new Set(assetList.map((asset) => String(asset.contract || "")).filter(Boolean));
  const paths = assetList.map((asset) => String(asset.path || ""));

  if (contracts.has("kfd-standards-metadata") || paths.includes("standards.json")) {
    return {
      role: KFD_UPSTREAM_ROLES.STANDARD_AND_SCHEMA_PROVIDER,
      roleSource: "evidence",
      roleReason: "Package evidence exposes KFD standards metadata.",
      roleValid: true,
    };
  }

  if (
    contracts.has("kungfu-buildchain-release-passport") ||
    contracts.has("kungfu-buildchain-kfd-claim-registry") ||
    paths.some((assetPath) => assetPath === "buildchain.release.json" || assetPath === "dist/site/kfd-claims.json")
  ) {
    return {
      role: KFD_UPSTREAM_ROLES.RELEASE_PASSPORT_AND_KFD_GATE_PROVIDER,
      roleSource: "evidence",
      roleReason: "Package evidence exposes Buildchain release passport or KFD gate facts.",
      roleValid: true,
    };
  }

  if (
    contracts.has("kungfu-buildchain-site-bundle") ||
    contracts.has("kungfu-buildchain-site-manifest") ||
    paths.some((assetPath) => assetPath === "dist/site/site-manifest.json" || assetPath === "dist/site/buildchain-site.json")
  ) {
    return {
      role: KFD_UPSTREAM_ROLES.SITE_CONSUMPTION_PROVIDER,
      roleSource: "evidence",
      roleReason: "Package evidence exposes site-consumption facts.",
      roleValid: true,
    };
  }

  if (
    contracts.has("kfd-3-collaboration-interface") ||
    contracts.has("kfd-2-trust-claims") ||
    contracts.has("kfd-2-trust-assessment") ||
    paths.some((assetPath) => assetPath.includes("/kfd-") || assetPath.startsWith(".buildchain/kfd-"))
  ) {
    return {
      role: KFD_UPSTREAM_ROLES.KFD_AWARE_PRODUCT_COMPONENT,
      roleSource: "evidence",
      roleReason: "Package evidence exposes KFD witness, claim, or collaboration-interface facts.",
      roleValid: true,
    };
  }

  return {
    role: KFD_UPSTREAM_ROLES.UNKNOWN_KFD_UPSTREAM,
    roleSource: "default",
    roleReason: "No Buildchain-known package or role-specific evidence matched; keeping the upstream visible without asking the consumer to invent a role.",
    roleValid: true,
  };
}

function releaseAnchorFromAssets(assets = []) {
  return assets.find((asset) => asset?.parsed && (
    String(asset.path || "").endsWith("release.json") ||
    String(asset.contract || "").includes("release")
  ))?.parsed || null;
}

function kfd3SurfaceCountFromAssets(assets = []) {
  const collaboration = assets.find((asset) => asset?.parsed && (
    asset.parsed.contract === "kfd-3-collaboration-interface" ||
    String(asset.path || "").includes("collaboration-interface")
  ))?.parsed;
  return Array.isArray(collaboration?.surfaces) ? collaboration.surfaces.length : 0;
}

function summarizeProduct({ cwd }) {
  const pkg = readLocalPackage(cwd);
  return {
    id: String(pkg.name || path.basename(path.resolve(cwd))).replace(/^@/, "").replace(/[^a-zA-Z0-9_.-]+/g, "-"),
    name: pkg.name || path.basename(path.resolve(cwd)),
    version: pkg.version || "",
    repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url || "",
  };
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

export function collectKfdUpstreamFacts({ cwd = process.cwd(), components = undefined, includeOwn = true } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const configured = configuredKfdUpstreamComponents(resolvedCwd);
  const explicitComponents = Array.isArray(components)
    ? components.map(normalizeKfdUpstreamComponent)
    : configured.components;
  const discoveredComponents = configured.autoDiscover ? autoDiscoveredKfdUpstreams(resolvedCwd) : [];
  const byId = new Map();
  for (const component of [...discoveredComponents, ...explicitComponents]) {
    byId.set(component.id, { ...(byId.get(component.id) || {}), ...component });
  }
  const upstreams = [...byId.values()].map((component, index) => {
    if (!component.packageName) {
      const roleFacts = inferKfdUpstreamRole({ component });
      return {
        id: component.id || `upstream-${index + 1}`,
        role: roleFacts.role,
        roleSource: roleFacts.roleSource,
        roleReason: roleFacts.roleReason,
        roleValid: roleFacts.roleValid,
        package: { name: "", version: "" },
        repository: component.repository || "",
        kfd: component.kfd || {},
        releasePassport: component.releasePassport || "",
        assets: [],
        residualRisk: component.residualRisk || [],
        status: "unresolved",
      };
    }
    const resolvedPackage = resolvePackage({ packageName: component.packageName, cwd: resolvedCwd });
    const evidence = component.evidence.length > 0 ? component.evidence : KFD_UPSTREAM_DEFAULT_EVIDENCE;
    const assets = evidence
      .map((spec) => assetFromSpec({ spec, resolvedPackage, cwd: resolvedCwd }))
      .filter(Boolean)
      .map((asset) => {
        const { parsed, ...summary } = asset;
        return summary;
      });
    const assetsWithParsed = evidence
      .map((spec) => assetFromSpec({ spec, resolvedPackage, cwd: resolvedCwd }))
      .filter(Boolean);
    const roleFacts = inferKfdUpstreamRole({ component, resolvedPackage, assets });
    return {
      id: component.id || resolvedPackage.name,
      role: roleFacts.role,
      roleSource: roleFacts.roleSource,
      roleReason: roleFacts.roleReason,
      roleValid: roleFacts.roleValid,
      package: {
        name: resolvedPackage.name,
        version: resolvedPackage.version,
      },
      repository: component.repository || resolvedPackage.repository,
      kfd: component.kfd,
      releasePassport: component.releasePassport || "",
      releaseAnchor: releaseAnchorFromAssets(assetsWithParsed),
      kfd3SurfaceCount: kfd3SurfaceCountFromAssets(assetsWithParsed),
      assets,
      residualRisk: component.residualRisk,
      status: assets.some((asset) => asset.missing && asset.required) ? "incomplete" : "collected",
    };
  });
  return {
    schemaVersion: 1,
    contract: KFD_UPSTREAM_AGGREGATE_CONTRACT,
    product: summarizeProduct({ cwd: resolvedCwd }),
    source: {
      generator: "@kungfu-tech/buildchain/kfd.collectKfdUpstreamFacts",
      configPath: configured.configPath,
      autoDiscover: configured.autoDiscover,
    },
    upstreams,
    ...(includeOwn ? { ownKfd: collectKfdStatus({ cwd: resolvedCwd }) } : {}),
    summary: {
      upstreamCount: upstreams.length,
      kfdAwareUpstreams: upstreams.map((entry) => entry.id),
      packageVersions: Object.fromEntries(upstreams.map((entry) => [entry.id, entry.package?.version || ""])),
      status: upstreams.some((entry) => entry.status === "incomplete" || entry.status === "unresolved") ? "incomplete" : "collected",
    },
  };
}

export function listKfdUpstreamRoles() {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-kfd-upstream-role-registry",
    roles: KFD_UPSTREAM_ROLE_DEFINITIONS.map((entry) => ({ ...entry })),
    policy: {
      consumerConfiguration: "role is optional; Buildchain infers it from package identity and evidence whenever possible",
      explicitRole: "explicit role values must be one of this registry",
      unknownExplicitRole: "fail-closed",
      fallbackRole: KFD_UPSTREAM_ROLES.UNKNOWN_KFD_UPSTREAM,
    },
    inference: {
      knownPackages: Object.fromEntries(Object.entries(KFD_UPSTREAM_KNOWN_PACKAGE_ROLES)),
      evidenceContracts: {
        "kfd-standards-metadata": KFD_UPSTREAM_ROLES.STANDARD_AND_SCHEMA_PROVIDER,
        "kungfu-buildchain-release-passport": KFD_UPSTREAM_ROLES.RELEASE_PASSPORT_AND_KFD_GATE_PROVIDER,
        "kungfu-buildchain-kfd-claim-registry": KFD_UPSTREAM_ROLES.RELEASE_PASSPORT_AND_KFD_GATE_PROVIDER,
        "kungfu-buildchain-site-bundle": KFD_UPSTREAM_ROLES.SITE_CONSUMPTION_PROVIDER,
        "kungfu-buildchain-site-manifest": KFD_UPSTREAM_ROLES.SITE_CONSUMPTION_PROVIDER,
        "kfd-3-collaboration-interface": KFD_UPSTREAM_ROLES.KFD_AWARE_PRODUCT_COMPONENT,
        "kfd-2-trust-claims": KFD_UPSTREAM_ROLES.KFD_AWARE_PRODUCT_COMPONENT,
        "kfd-2-trust-assessment": KFD_UPSTREAM_ROLES.KFD_AWARE_PRODUCT_COMPONENT,
      },
    },
  };
}

export function checkKfdUpstreamFacts(aggregate = {}) {
  const issues = [];
  if (!aggregate || typeof aggregate !== "object" || Array.isArray(aggregate)) {
    issues.push(issue("error", "kfd.upstream.object", "KFD upstream aggregate must be a JSON object"));
  }
  if (aggregate.contract !== KFD_UPSTREAM_AGGREGATE_CONTRACT) {
    issues.push(issue("error", "kfd.upstream.contract", `KFD upstream aggregate contract must be ${KFD_UPSTREAM_AGGREGATE_CONTRACT}`));
  }
  const upstreams = Array.isArray(aggregate.upstreams) ? aggregate.upstreams : [];
  if (upstreams.length === 0) {
    issues.push(issue("warning", "kfd.upstream.empty", "KFD upstream aggregate has no upstream components"));
  }
  for (const [index, upstream] of upstreams.entries()) {
    const label = `kfd.upstream.upstreams[${index}]`;
    if (!upstream?.id) {
      issues.push(issue("error", `${label}.id`, "KFD upstream component must include id"));
    }
    if (!upstream?.role) {
      issues.push(issue("error", `${label}.role`, "KFD upstream component must include role"));
    } else if (!KFD_UPSTREAM_ROLE_SET.has(upstream.role)) {
      issues.push(issue("error", `${label}.role`, `KFD upstream role must be one of: ${[...KFD_UPSTREAM_ROLE_SET].join(", ")}`, {
        id: upstream?.id || "",
        role: upstream.role,
        roleSource: upstream.roleSource || "",
      }));
    }
    if (!upstream?.package?.name || !upstream?.package?.version) {
      issues.push(issue("error", `${label}.package`, "KFD upstream component must include package name and version"));
    }
    const assets = Array.isArray(upstream?.assets) ? upstream.assets : [];
    if (assets.length === 0 && !upstream?.releasePassport) {
      issues.push(issue("warning", `${label}.evidence`, "KFD upstream component has no package assets or release passport evidence", {
        id: upstream?.id || "",
      }));
    }
    for (const [assetIndex, asset] of assets.entries()) {
      if (asset.missing && asset.required) {
        issues.push(issue("error", `${label}.assets[${assetIndex}].missing`, "required KFD upstream evidence asset is missing", {
          id: upstream?.id || "",
          path: asset.path || "",
        }));
      } else if (!asset.sha256) {
        issues.push(issue("error", `${label}.assets[${assetIndex}].sha256`, "KFD upstream evidence asset must include sha256", {
          id: upstream?.id || "",
          path: asset.path || "",
        }));
      }
    }
    const kfdStates = upstream?.kfd && typeof upstream.kfd === "object" && !Array.isArray(upstream.kfd)
      ? Object.entries(upstream.kfd)
      : [];
    for (const [standard, state] of kfdStates) {
      if (String(state).toLowerCase() === "passed" && !upstream.releasePassport) {
        issues.push(issue("error", `${label}.kfd.${standard}`, "upstream KFD passed state requires a release passport; use declared/aligned/exported-* for package-local evidence", {
          id: upstream?.id || "",
        }));
      }
    }
  }
  const ok = issues.filter((entry) => entry.level === "error").length === 0;
  return {
    schemaVersion: 1,
    contract: KFD_UPSTREAM_CHECK_CONTRACT,
    ok,
    status: ok ? "passed" : "failed",
    upstreamCount: upstreams.length,
    issues,
  };
}

export function collectKfdAggregate({ cwd = process.cwd() } = {}) {
  const upstream = collectKfdUpstreamFacts({ cwd });
  const upstreamCheck = checkKfdUpstreamFacts(upstream);
  return {
    schemaVersion: 1,
    contract: KFD_AGGREGATE_CONTRACT,
    product: upstream.product,
    own: {
      status: collectKfdStatus({ cwd }),
    },
    upstream,
    upstreamCheck,
    kfd: {
      kfd1: "own-status-plus-upstream-contract-world-facts",
      kfd2: "own-release-passport-plus-upstream-trust-surface",
      kfd3: "own-collaboration-interface-plus-upstream-capability-facts",
      kfd4: "schema-only-unless-product-declares-more",
    },
  };
}

export const upstream = Object.freeze({
  collect: collectKfdUpstreamFacts,
  check: checkKfdUpstreamFacts,
  aggregate: collectKfdAggregate,
  roles: listKfdUpstreamRoles,
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
      "kfd-2": ["schema", "taxonomy", "claims", "trust-claims", "trust-assessment", "upstream"],
      "kfd-3": ["schema", "detect", "register", "audit", "witness", "query", "aggregate"],
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
