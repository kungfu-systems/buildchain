import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveKfd3SurfaceRegistryPath } from "./buildchain-layout.js";

export const KFD3_SURFACE_REGISTRY_CONTRACT = "kungfu-buildchain-kfd-3-surface-registry";
export const KFD3_SURFACE_DETECTION_CONTRACT = "kungfu-buildchain-kfd-3-surface-detection";
export const KFD3_SURFACE_AUDIT_CONTRACT = "kungfu-buildchain-kfd-3-surface-audit";
export const KFD3_CAPABILITY_QUERY_CONTRACT = "kungfu-buildchain-kfd-3-capability-query";
export const KFD3_DEFAULT_REGISTRY_PATH = ".buildchain/kfd/kfd-3-surfaces.json";

const KIND_ALIASES = Object.freeze({
  "node-api": "node-api",
  node: "node-api",
  npm: "node-api",
  "python-api": "python-api",
  python: "python-api",
  wheel: "python-api",
  cli: "cli",
  command: "cli",
  binary: "binary",
  "standalone-binary": "binary",
  docs: "documentation",
  documentation: "documentation",
  site: "site-bundle",
  "site-bundle": "site-bundle",
});

function readText(filePath, fallback = "") {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : fallback;
}

function readJsonFile(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

function sha256File(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
    : "";
}

function normalizeKind(kind) {
  const normalized = KIND_ALIASES[String(kind || "").trim().toLowerCase()];
  if (!normalized) {
    throw new Error(`unsupported KFD-3 surface kind: ${kind}`);
  }
  return normalized;
}

function normalizeKinds(kinds = []) {
  const selected = kinds.length ? kinds : ["node-api", "python-api", "cli", "binary", "documentation", "site-bundle"];
  return [...new Set(selected.map(normalizeKind))].sort();
}

function stableId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "") || "surface";
}

function surface({ id, kind, name, sourcePath = "", artifactPath = "", evidencePath = "", detectionMethod, policy = {}, facts = {} }) {
  return {
    id,
    kind,
    name: name || id,
    visibility: "public",
    participantFacing: true,
    state: "detected",
    sourcePath,
    artifactPath: artifactPath || sourcePath,
    evidencePath: evidencePath || sourcePath,
    detectionMethod,
    policy,
    facts,
  };
}

function listFilesRecursive(root, relDir, predicate = () => true) {
  const absoluteDir = path.join(root, relDir);
  if (!fs.existsSync(absoluteDir)) return [];
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        const relPath = path.relative(root, absolutePath).replace(/\\/g, "/");
        if (predicate(relPath, entry.name)) out.push(relPath);
      }
    }
  };
  visit(absoluteDir);
  return out.sort();
}

function detectNodeApiSurfaces({ cwd, packageJson = undefined } = {}) {
  const pkgPath = path.join(cwd, "package.json");
  const pkg = packageJson || readJsonFile(pkgPath, {});
  if (!pkg.name && !pkg.exports && !pkg.main && !pkg.types) return [];
  const entries = [];
  for (const [specifier, target] of Object.entries(pkg.exports || {})) {
    if (specifier.startsWith("./site/") || specifier === "./package.json") continue;
    const targetPath = typeof target === "string" ? target.replace(/^\.\//, "") : "";
    entries.push(surface({
      id: `node-api:${stableId(specifier === "." ? pkg.name : `${pkg.name}/${specifier.replace(/^\.\//, "")}`)}`,
      kind: "node-api",
      name: specifier === "." ? pkg.name : `${pkg.name}/${specifier.replace(/^\.\//, "")}`,
      sourcePath: targetPath || "package.json",
      detectionMethod: "package.json#exports",
      facts: { packageName: pkg.name || "", export: specifier, target },
    }));
  }
  for (const [field, kind] of [["main", "main"], ["types", "types"]]) {
    if (!pkg[field]) continue;
    entries.push(surface({
      id: `node-api:${kind}:${stableId(pkg[field])}`,
      kind: "node-api",
      name: `${pkg.name || "package"} ${kind}`,
      sourcePath: String(pkg[field]).replace(/^\.\//, ""),
      detectionMethod: `package.json#${field}`,
      facts: { packageName: pkg.name || "", field, target: pkg[field] },
    }));
  }
  return entries;
}

function detectCliSurfaces({ cwd, packageJson = undefined } = {}) {
  const pkg = packageJson || readJsonFile(path.join(cwd, "package.json"), {});
  const entries = [];
  const bins = typeof pkg.bin === "string"
    ? [[pkg.name || "cli", pkg.bin]]
    : Object.entries(pkg.bin || {});
  for (const [name, target] of bins) {
    entries.push(surface({
      id: `cli:${stableId(name)}`,
      kind: "cli",
      name,
      sourcePath: String(target).replace(/^\.\//, ""),
      detectionMethod: "package.json#bin",
      facts: { packageName: pkg.name || "", binName: name, target },
    }));
  }
  for (const relPath of listFilesRecursive(cwd, "bin", (relPath) => /\.m?js$|\.c?js$|\.sh$|\.exe$/.test(relPath))) {
    const name = path.basename(relPath).replace(/\.(mjs|cjs|js|sh|exe)$/i, "");
    if (entries.some((entry) => entry.sourcePath === relPath)) continue;
    entries.push(surface({
      id: `cli:${stableId(name)}`,
      kind: "cli",
      name,
      sourcePath: relPath,
      detectionMethod: "bin-directory",
      facts: { path: relPath },
    }));
  }
  return entries;
}

function parseMetadata(text) {
  const metadata = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (match) metadata[match[1].toLowerCase()] = match[2].trim();
  }
  return metadata;
}

function parseEntryPoints(text) {
  const points = [];
  let group = "";
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const groupMatch = line.match(/^\[([^\]]+)\]$/);
    if (groupMatch) {
      group = groupMatch[1];
      continue;
    }
    const entryMatch = line.match(/^([^=]+)=\s*(.+)$/);
    if (entryMatch) {
      points.push({ group, name: entryMatch[1].trim(), target: entryMatch[2].trim() });
    }
  }
  return points;
}

function distInfoDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".dist-info"))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function detectPythonWheelSurfaces({ cwd, artifactPath = "" } = {}) {
  const root = path.resolve(cwd, artifactPath || ".");
  const entries = [];
  for (const infoDir of distInfoDirs(root)) {
    const relInfoDir = path.relative(cwd, infoDir).replace(/\\/g, "/") || path.basename(infoDir);
    const metadata = parseMetadata(readText(path.join(infoDir, "METADATA")));
    const recordText = readText(path.join(infoDir, "RECORD"));
    const entryPoints = parseEntryPoints(readText(path.join(infoDir, "entry_points.txt")));
    const topLevelText = readText(path.join(infoDir, "top_level.txt"));
    const packageName = metadata.name || path.basename(infoDir).replace(/\.dist-info$/, "");
    const topLevelPackages = [
      ...topLevelText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      ...recordText.split(/\r?\n/).map((line) => line.split(",")[0]).filter(Boolean)
        .map((recordPath) => recordPath.split(/[\\/]/)[0])
        .filter((segment) => segment && !segment.endsWith(".dist-info") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)),
    ];
    for (const moduleName of [...new Set(topLevelPackages)].sort()) {
      entries.push(surface({
        id: `python-api:${stableId(packageName)}:${stableId(moduleName)}`,
        kind: "python-api",
        name: `${packageName}:${moduleName}`,
        sourcePath: relInfoDir,
        artifactPath: relInfoDir,
        detectionMethod: "wheel-dist-info",
        policy: { publicApiPolicy: "top-level-package-metadata" },
        facts: { packageName, version: metadata.version || "", moduleName },
      }));
    }
    for (const point of entryPoints) {
      entries.push(surface({
        id: `cli:${stableId(packageName)}:${stableId(point.name)}`,
        kind: "cli",
        name: point.name,
        sourcePath: `${relInfoDir}/entry_points.txt`,
        artifactPath: `${relInfoDir}/entry_points.txt`,
        detectionMethod: "wheel-entry-points",
        facts: { packageName, version: metadata.version || "", entryPointGroup: point.group, target: point.target },
      }));
    }
  }
  return entries;
}

function detectBinarySurfaces({ cwd, artifactPath = "" } = {}) {
  const roots = [artifactPath, "dist", "build", "target/release"].filter(Boolean);
  const seen = new Set();
  const entries = [];
  for (const relRoot of roots) {
    for (const relPath of listFilesRecursive(cwd, relRoot, (candidate, name) => {
      return /\.(exe|dll|dylib|so|a|lib|zip|tar\.gz|tgz)$/i.test(candidate) || (!name.includes(".") && candidate.includes("/"));
    })) {
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      entries.push(surface({
        id: `binary:${stableId(relPath)}`,
        kind: "binary",
        name: path.basename(relPath),
        sourcePath: relPath,
        artifactPath: relPath,
        detectionMethod: "artifact-path-scan",
        facts: { path: relPath, sha256: sha256File(path.join(cwd, relPath)) },
      }));
    }
  }
  return entries;
}

function detectDocumentationSurfaces({ cwd } = {}) {
  return [
    ...listFilesRecursive(cwd, "docs", (relPath) => relPath.endsWith(".md")),
    "README.md",
    "AGENTS.md",
  ]
    .filter((relPath) => fs.existsSync(path.join(cwd, relPath)))
    .map((relPath) => surface({
      id: `doc:${stableId(relPath)}`,
      kind: "documentation",
      name: relPath,
      sourcePath: relPath,
      detectionMethod: "documentation-scan",
      facts: { path: relPath, sha256: sha256File(path.join(cwd, relPath)) },
    }));
}

function detectSiteBundleSurfaces({ cwd } = {}) {
  return listFilesRecursive(cwd, "dist/site", (relPath) => relPath.endsWith(".json"))
    .map((relPath) => surface({
      id: `site-bundle:${stableId(relPath)}`,
      kind: "site-bundle",
      name: relPath,
      sourcePath: relPath,
      artifactPath: relPath,
      detectionMethod: "buildchain-site-bundle",
      facts: { path: relPath, sha256: sha256File(path.join(cwd, relPath)) },
    }));
}

function uniqueSurfaces(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (!entry?.id || byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function detectKfd3Surfaces({ cwd = process.cwd(), kinds = [], artifactPath = "" } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const selectedKinds = normalizeKinds(kinds);
  const packageJson = readJsonFile(path.join(resolvedCwd, "package.json"), {});
  const detectedAt = process.env.BUILDCHAIN_KFD3_DETECTED_AT || process.env.BUILDCHAIN_SURFACE_GENERATED_AT || new Date().toISOString();
  const surfaces = [];
  if (selectedKinds.includes("node-api")) surfaces.push(...detectNodeApiSurfaces({ cwd: resolvedCwd, packageJson }));
  if (selectedKinds.includes("python-api")) surfaces.push(...detectPythonWheelSurfaces({ cwd: resolvedCwd, artifactPath }));
  if (selectedKinds.includes("cli")) surfaces.push(...detectCliSurfaces({ cwd: resolvedCwd, packageJson }));
  if (selectedKinds.includes("binary")) surfaces.push(...detectBinarySurfaces({ cwd: resolvedCwd, artifactPath }));
  if (selectedKinds.includes("documentation")) surfaces.push(...detectDocumentationSurfaces({ cwd: resolvedCwd }));
  if (selectedKinds.includes("site-bundle")) surfaces.push(...detectSiteBundleSurfaces({ cwd: resolvedCwd }));
  const detected = uniqueSurfaces(surfaces);
  return {
    schemaVersion: 1,
    contract: KFD3_SURFACE_DETECTION_CONTRACT,
    cwd: resolvedCwd,
    artifactPath,
    detectedAt,
    kinds: selectedKinds,
    summary: {
      surfaceCount: detected.length,
      byKind: Object.fromEntries(selectedKinds.map((kind) => [kind, detected.filter((entry) => entry.kind === kind).length])),
    },
    surfaces: detected,
  };
}

function resolveRegistryPath(cwd, registryPath) {
  return registryPath || resolveKfd3SurfaceRegistryPath(cwd);
}

export function readKfd3SurfaceRegistry({ cwd = process.cwd(), registryPath = "" } = {}) {
  const effectiveRegistryPath = resolveRegistryPath(cwd, registryPath);
  const filePath = path.resolve(cwd, effectiveRegistryPath);
  const registry = readJsonFile(filePath, null);
  if (!registry) {
    return {
      schemaVersion: 1,
      contract: KFD3_SURFACE_REGISTRY_CONTRACT,
      product: {},
      registryPath: effectiveRegistryPath,
      surfaces: [],
    };
  }
  return {
    schemaVersion: registry.schemaVersion || 1,
    contract: registry.contract || KFD3_SURFACE_REGISTRY_CONTRACT,
    product: registry.product || {},
    registryPath: registry.registryPath || effectiveRegistryPath,
    surfaces: Array.isArray(registry.surfaces) ? registry.surfaces : [],
    policy: registry.policy || {},
  };
}

export function writeKfd3SurfaceRegistry({ cwd = process.cwd(), registryPath = "", registry }) {
  const effectiveRegistryPath = resolveRegistryPath(cwd, registryPath);
  const next = {
    schemaVersion: 1,
    contract: KFD3_SURFACE_REGISTRY_CONTRACT,
    product: registry.product || {},
    registryPath: effectiveRegistryPath,
    surfaces: uniqueSurfaces(registry.surfaces || []).map((entry) => ({
      ...entry,
      state: entry.state || "declared",
      declaration: entry.declaration || {
        owner: "product",
        source: "buildchain kfd 3 register",
      },
    })),
    policy: registry.policy || {
      detectedButUnregistered: "warn",
      declaredButMissing: "fail",
    },
  };
  writeJsonFile(path.resolve(cwd, effectiveRegistryPath), next);
  return next;
}

export function registerKfd3Surfaces({
  cwd = process.cwd(),
  registryPath = "",
  kinds = [],
  artifactPath = "",
  product = {},
} = {}) {
  const detection = detectKfd3Surfaces({ cwd, kinds, artifactPath });
  const registry = readKfd3SurfaceRegistry({ cwd, registryPath });
  const existing = new Map((registry.surfaces || []).map((entry) => [entry.id, entry]));
  for (const detected of detection.surfaces) {
    existing.set(detected.id, {
      ...detected,
      ...(existing.get(detected.id) || {}),
      id: detected.id,
      kind: detected.kind,
      name: detected.name,
      state: existing.get(detected.id)?.state || "declared",
      sourcePath: detected.sourcePath,
      artifactPath: detected.artifactPath,
      evidencePath: detected.evidencePath,
      detectionMethod: detected.detectionMethod,
      facts: detected.facts,
    });
  }
  const next = writeKfd3SurfaceRegistry({
    cwd,
    registryPath,
    registry: {
      ...registry,
      product: { ...registry.product, ...product },
      surfaces: [...existing.values()],
    },
  });
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-kfd-3-surface-register",
    registryPath,
    registeredCount: detection.surfaces.length,
    registrySurfaceCount: next.surfaces.length,
    detection,
    registry: next,
  };
}

export function auditKfd3Surfaces({
  cwd = process.cwd(),
  registryPath = "",
  kinds = [],
  artifactPath = "",
} = {}) {
  const detection = detectKfd3Surfaces({ cwd, kinds, artifactPath });
  const registry = readKfd3SurfaceRegistry({ cwd, registryPath });
  const detectedIds = new Set(detection.surfaces.map((entry) => entry.id));
  const declaredIds = new Set(registry.surfaces.map((entry) => entry.id));
  const detectedButUnregistered = detection.surfaces.filter((entry) => !declaredIds.has(entry.id));
  const declaredButMissing = registry.surfaces.filter((entry) => !detectedIds.has(entry.id));
  const enforced = registry.surfaces.filter((entry) => entry.state === "enforced" || entry.enforcement === "enforced");
  const issues = [
    ...detectedButUnregistered.map((entry) => ({
      level: "warning",
      code: "detected-unregistered",
      surfaceId: entry.id,
      message: `Detected public surface is not declared: ${entry.id}`,
    })),
    ...declaredButMissing.map((entry) => ({
      level: "error",
      code: "declared-missing",
      surfaceId: entry.id,
      message: `Declared public surface was not detected: ${entry.id}`,
    })),
  ];
  return {
    schemaVersion: 1,
    contract: KFD3_SURFACE_AUDIT_CONTRACT,
    ok: issues.every((issue) => issue.level !== "error"),
    status: issues.some((issue) => issue.level === "error") ? "failed" : detectedButUnregistered.length ? "partial" : "passed",
    registryPath,
    detection,
    registry,
    summary: {
      detected: detection.surfaces.length,
      declared: registry.surfaces.length,
      enforced: enforced.length,
      detectedButUnregistered: detectedButUnregistered.length,
      declaredButMissing: declaredButMissing.length,
    },
    states: {
      detected: detection.surfaces,
      declared: registry.surfaces,
      enforced,
    },
    comparison: {
      detectedButUnregistered,
      declaredButMissing,
    },
    issues,
  };
}

export function createKfd3SurfaceWitness({
  cwd = process.cwd(),
  registryPath = "",
  kind = "prebuild",
  sourceSha = "",
  artifactPath = "",
} = {}) {
  const audit = auditKfd3Surfaces({ cwd, registryPath, artifactPath });
  const registryDigest = `sha256:${sha256Json(audit.registry)}`;
  const collaborationInterface = {
    schemaVersion: 1,
    contract: KFD3_SURFACE_REGISTRY_CONTRACT,
    product: audit.registry.product,
    surfaces: audit.registry.surfaces,
    detectedSurfaces: audit.detection.surfaces,
    audit,
  };
  return {
    schemaVersion: 1,
    id: audit.registry.product?.id || audit.registry.product?.name || "kfd-3-surface-registry",
    standard: "kfd-3",
    witnessKind: kind,
    supportLevel: audit.status === "passed" ? "release" : "declared",
    source: {
      cwd: path.resolve(cwd),
      sourceSha,
      registryPath,
      registryDigest,
    },
    sourceRegistry: {
      id: audit.registry.product?.id || audit.registry.product?.name || "product-kfd-3-surface-registry",
      path: registryPath,
      sha256: sha256File(path.resolve(cwd, registryPath)),
    },
    collaborationInterfaceDigest: `sha256:${sha256Json(collaborationInterface)}`,
    collaborationInterface,
    auditBoundary: {
      mode: audit.status === "passed" ? "closed-world" : "declared-boundary",
      scope: "KFD-3 registered product public surfaces detected by Buildchain",
      detectedButUnregisteredPolicy: "warn",
      declaredButMissingPolicy: "fail",
    },
    residualRisk: audit.comparison.detectedButUnregistered.map((entry) => ({
      surfaceId: entry.id,
      riskType: "unregistered-detected-surface",
      trustImpact: "manual-review-required",
      machineProvability: "machine-detected",
      agentAction: "register-or-exempt-surface",
      message: `Detected public surface is not yet declared: ${entry.id}`,
    })),
    responsibility: {
      registryFactsOwner: "product",
      artifactVerificationOwner: "Buildchain KFD-3 surface audit",
      releasePassportProofOwner: "Buildchain",
    },
  };
}

async function readJsonLocation(location) {
  if (!location) return null;
  if (/^https?:\/\//.test(location)) {
    const response = await fetch(location);
    if (!response.ok) {
      throw new Error(`failed to fetch ${location}: HTTP ${response.status}`);
    }
    return response.json();
  }
  return readJsonFile(path.resolve(location), null);
}

function kfd2TrustForCapability(passport, surfaceId) {
  const claims = passport?.["kfd-2"]?.claims || passport?.kfd2?.claims || [];
  const related = claims.find((claim) => {
    const haystack = JSON.stringify(claim);
    return haystack.includes(surfaceId) || haystack.includes("kfd-3");
  });
  if (!related) {
    return {
      status: "unknown",
      trustImpact: "passport-claim-not-found",
      residualRisk: [],
    };
  }
  return {
    status: related.verification?.result || related.releaseStatus || "declared",
    trustImpact: related.trustProof?.releaseStatus || related.verification?.result || "review",
    residualRisk: related.residualRisk || related.trustProof?.residualRisk || [],
    claimId: related.id || "",
  };
}

function capabilitiesFromRegistry({ registry, audit, passport = null }) {
  const detectedById = new Map((audit?.detection?.surfaces || []).map((entry) => [entry.id, entry]));
  return (registry.surfaces || []).map((entry) => {
    const detected = detectedById.get(entry.id);
    return {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      state: entry.state || "declared",
      detected: Boolean(detected),
      enforced: entry.state === "enforced" || entry.enforcement === "enforced",
      sourcePath: entry.sourcePath,
      artifactPath: entry.artifactPath,
      evidencePath: entry.evidencePath,
      kfd1Basis: {
        registryPath: registry.registryPath || KFD3_DEFAULT_REGISTRY_PATH,
        sourcePath: entry.sourcePath,
        artifactPath: entry.artifactPath,
        digest: `sha256:${sha256Json(entry)}`,
      },
      kfd2Trust: kfd2TrustForCapability(passport, entry.id),
      residualRisk: detected ? [] : [{
        riskType: "declared-surface-not-detected",
        trustImpact: "verification-required",
        machineProvability: "machine-detected",
        agentAction: "run-buildchain-kfd-3-audit",
      }],
    };
  });
}

export async function queryKfd3Capabilities({
  cwd = process.cwd(),
  product = "",
  registryPath = "",
  passportLocation = "",
  artifactPath = "",
} = {}) {
  const passport = await readJsonLocation(passportLocation);
  if (passport) {
    const kfd3 = passport["kfd-3"] || passport.kfd3 || {};
    const interfaces = Array.isArray(kfd3.collaborationInterfaces)
      ? kfd3.collaborationInterfaces
      : [kfd3.collaborationInterface].filter(Boolean);
    const surfaces = interfaces.flatMap((entry) => entry?.surfaces || entry?.declaredSurfaces || []);
    return {
      schemaVersion: 1,
      contract: KFD3_CAPABILITY_QUERY_CONTRACT,
      product: product || passport.product?.name || passport.package?.name || "release-passport",
      source: { type: "release-passport", location: passportLocation },
      release: passport.release || {},
      capabilities: surfaces.map((entry) => ({
        id: entry.id || entry.name,
        kind: entry.kind || "surface",
        name: entry.name || entry.id,
        state: entry.state || "declared",
        detected: true,
        enforced: kfd3.releaseStatus === "enforced",
        kfd1Basis: { sourcePath: entry.sourcePath || "", artifactPath: entry.artifactPath || "", digest: entry.digest || "" },
        kfd2Trust: kfd2TrustForCapability(passport, entry.id || entry.name || ""),
        residualRisk: entry.residualRisk || [],
      })),
      kfd: {
        kfd1: passport["kfd-1"]?.result || passport.kfd1?.result || "unknown",
        kfd2: passport["kfd-2"]?.result || passport.kfd2?.result || "unknown",
        kfd3: kfd3.result || kfd3.releaseStatus || "unknown",
      },
    };
  }

  const effectiveRegistryPath = resolveRegistryPath(cwd, registryPath);
  const registry = readKfd3SurfaceRegistry({ cwd, registryPath: effectiveRegistryPath });
  const hasRegistry = fs.existsSync(path.resolve(cwd, effectiveRegistryPath));
  const audit = hasRegistry ? auditKfd3Surfaces({ cwd, registryPath: effectiveRegistryPath, artifactPath }) : null;
  if (hasRegistry) {
    return {
      schemaVersion: 1,
      contract: KFD3_CAPABILITY_QUERY_CONTRACT,
      product: product || registry.product?.name || registry.product?.id || "local-product",
      source: { type: "surface-registry", path: effectiveRegistryPath },
      status: audit.status,
      summary: audit.summary,
      capabilities: capabilitiesFromRegistry({ registry, audit }),
      kfd: {
        kfd1: "registry-facts",
        kfd2: passport ? "passport-trust" : "not-attached",
        kfd3: audit.status,
      },
    };
  }

  if (!product || product === "buildchain" || product === "@kungfu-tech/buildchain") {
    const claimsPath = path.join(cwd, "dist/site/kfd-claims.json");
    const claims = readJsonFile(claimsPath, null);
    if (claims?.collaborationSurfaces) {
      const registryFromClaims = {
        product: claims.product || { name: "Buildchain" },
        registryPath: "dist/site/kfd-claims.json",
        surfaces: [
          ...Object.values(claims.collaborationSurfaces.groups || {}).flat(),
          ...(claims.collaborationSurfaces.additionalSurfaces || []),
        ],
      };
      return {
        schemaVersion: 1,
        contract: KFD3_CAPABILITY_QUERY_CONTRACT,
        product: "Buildchain",
        source: { type: "buildchain-site-kfd-claims", path: "dist/site/kfd-claims.json" },
        status: claims.publicSurfaceReverseAudit?.status || "declared",
        summary: {
          declared: registryFromClaims.surfaces.length,
          publicSurfaceCount: claims.collaborationSurfaces.publicSurfaceCount,
        },
        capabilities: capabilitiesFromRegistry({ registry: registryFromClaims, audit: { detection: { surfaces: registryFromClaims.surfaces } } }),
        kfd: {
          kfd1: "self-contract-registry",
          kfd2: "public-claim-registry",
          kfd3: claims.publicSurfaceReverseAudit?.status || "declared",
        },
      };
    }
  }

  throw new Error(`no KFD-3 registry, passport, or known product facts found for ${product || "local product"}`);
}
