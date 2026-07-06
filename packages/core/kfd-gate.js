import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const KFD1_RELEASE_GATE_CONTRACT = "kungfu-buildchain-kfd-1-release-gate";
export const KFD1_WITNESS_SET_CONTRACT = "kungfu-buildchain-kfd-1-witness-set";
export const BUILDCHAIN_JSON_FORMATTING_POLICY = Object.freeze({
  name: "buildchain-release-evidence-json-v1",
  indentation: 2,
  trailingNewline: true,
  canonicalDigest: "stable-json-sha256-v1",
});

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function nonEmptyString(value, label) {
  const normalized = optionalString(value).trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
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

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256Json(value) {
  return sha256Bytes(stableJson(value));
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJsonPackageExport(exportPath) {
  return JSON.parse(fs.readFileSync(require.resolve(exportPath), "utf8"));
}

function loadKfdPackageMetadata() {
  const packageJson = readJsonPackageExport("@kungfu-tech/kfd/package.json");
  const standards = readJsonPackageExport("@kungfu-tech/kfd/standards.json");
  return { packageJson, standards };
}

export function resolveKfd1Metadata() {
  const { packageJson, standards } = loadKfdPackageMetadata();
  const entries = Object.entries(standards.standards || {});
  const entry = entries.find(([key, value]) => {
    const names = [key, value?.key, value?.id, value?.label]
      .filter(Boolean)
      .map((name) => String(name).toLowerCase());
    return (
      names.includes("kfd-1") &&
      value?.schemaIds?.contractWorld &&
      value?.schemaIds?.witness &&
      value?.schemaPaths?.contractWorld &&
      value?.schemaPaths?.witness
    );
  });
  if (!entry) {
    throw new Error("KFD metadata package does not expose the KFD-1 contract-world witness standard");
  }
  const [key, standard] = entry;
  return {
    key: standard.key || key,
    id: standard.id || standard.label || key,
    label: standard.label || standard.id || key,
    title: standard.title || "",
    status: standard.status || "",
    revision: standard.revision || 0,
    package: {
      name: packageJson.name,
      version: packageJson.version,
      repository: packageJson.repository?.url || "",
    },
    schemaIds: { ...standard.schemaIds },
    schemaPaths: { ...standard.schemaPaths },
    concepts: { ...(standard.concepts || {}) },
    metadataSchema: standards.metadataSchema || {},
    source: standards.source || {},
  };
}

function normalizeHash(value, label, { required = false } = {}) {
  const text = optionalString(value).replace(/^sha256:/, "").trim();
  if (!text && !required) {
    return "";
  }
  if (!/^[0-9a-f]{64}$/i.test(text)) {
    throw new Error(`${label} must be a sha256 hex digest`);
  }
  return text.toLowerCase();
}

function normalizePath(value, label) {
  const text = nonEmptyString(value, label).replace(/\\/g, "/");
  if (path.isAbsolute(text)) {
    throw new Error(`${label} must be repository-relative`);
  }
  if (text.split("/").some((part) => part === "..")) {
    throw new Error(`${label} must not contain ..`);
  }
  return text;
}

function normalizeEvidenceFile(value, label) {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return { path: normalizePath(value, `${label}.path`) };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return {
    ...value,
    path: value.path ? normalizePath(value.path, `${label}.path`) : "",
    sha256: value.sha256 ? normalizeHash(value.sha256, `${label}.sha256`) : "",
  };
}

function normalizeSurface(surface, index) {
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
    throw new Error(`surfaces[${index}] must be an object`);
  }
  const artifactPath = normalizePath(surface.artifactPath || surface.artifact_path, `surfaces[${index}].artifactPath`);
  return {
    name: nonEmptyString(surface.name || surface.id, `surfaces[${index}].name`),
    sourcePath: surface.sourcePath || surface.source_path
      ? normalizePath(surface.sourcePath || surface.source_path, `surfaces[${index}].sourcePath`)
      : "",
    sourceSha256: normalizeHash(surface.sourceSha256 || surface.source_sha256, `surfaces[${index}].sourceSha256`),
    artifactPath,
    expectedSha256: normalizeHash(surface.expectedSha256 || surface.expected_sha256, `surfaces[${index}].expectedSha256`, { required: true }),
    byteForByte: surface.byteForByte === undefined && surface.byte_for_byte === undefined
      ? true
      : Boolean(surface.byteForByte ?? surface.byte_for_byte),
  };
}

export function normalizeKfd1ContractWorldWitness(witness, { metadata = resolveKfd1Metadata() } = {}) {
  if (!witness || typeof witness !== "object" || Array.isArray(witness)) {
    throw new Error("KFD-1 witness must be a JSON object");
  }
  const surfaces = Array.isArray(witness.surfaces)
    ? witness.surfaces.map((surface, index) => normalizeSurface(surface, index))
    : [];
  if (surfaces.length === 0) {
    throw new Error("KFD-1 witness surfaces[] must include at least one artifact surface");
  }
  const standard = optionalString(witness.standard || metadata.key);
  if (standard && standard !== metadata.key && standard !== metadata.id && standard !== metadata.label) {
    throw new Error(`KFD-1 witness standard must match ${metadata.key}`);
  }
  return {
    schemaVersion: 1,
    contract: KFD1_WITNESS_SET_CONTRACT,
    id: nonEmptyString(witness.id, "KFD-1 witness id"),
    standard: metadata.key,
    standardLabel: metadata.label,
    source: witness.source && typeof witness.source === "object" && !Array.isArray(witness.source)
      ? { ...witness.source }
      : {},
    contractWorld: witness.contractWorld && typeof witness.contractWorld === "object" && !Array.isArray(witness.contractWorld)
      ? {
          ...witness.contractWorld,
          schemaId: witness.contractWorld.schemaId || metadata.schemaIds.contractWorld,
          digest: optionalString(witness.contractWorld.digest || witness.contractWorld.sha256),
        }
      : {
          schemaId: metadata.schemaIds.contractWorld,
          digest: "",
        },
    canonicalPolicy: normalizeEvidenceFile(witness.canonicalPolicy || witness.canonical_policy, "canonicalPolicy"),
    registry: normalizeEvidenceFile(witness.registry, "registry"),
    surfaces,
    metadata: {
      kfdPackage: metadata.package,
      schemaIds: metadata.schemaIds,
      schemaPaths: metadata.schemaPaths,
    },
  };
}

function resolveArtifactFile({ cwd, artifactRoot, artifacts = [], artifactPath }) {
  const candidates = [
    path.resolve(cwd, artifactPath),
    artifactRoot ? path.resolve(artifactRoot, artifactPath) : "",
  ].filter(Boolean);
  for (const artifact of artifacts) {
    const sourcePath = artifact.sourcePath || artifact.path || "";
    if (!sourcePath) {
      continue;
    }
    const normalizedSource = sourcePath.replace(/\\/g, "/");
    if (normalizedSource === artifactPath || normalizedSource.endsWith(`/${artifactPath}`)) {
      candidates.push(path.resolve(sourcePath));
    }
    const name = artifact.name || artifact.filename || "";
    if (name && name === artifactPath) {
      candidates.push(path.resolve(sourcePath));
    }
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || "";
}

export function createKfd1ReleaseGateEvidence({
  cwd = process.cwd(),
  artifactRoot = "",
  artifacts = [],
  witnesses = [],
  verifiedAt = new Date().toISOString(),
  metadata = resolveKfd1Metadata(),
} = {}) {
  const normalizedWitnesses = witnesses.map((witness) => normalizeKfd1ContractWorldWitness(witness, { metadata }));
  if (normalizedWitnesses.length === 0) {
    return undefined;
  }
  const worlds = normalizedWitnesses.map((witness) => {
    const preBuildWitnessSha256 = sha256Json(witness);
    const surfaceResults = witness.surfaces.map((surface) => {
      const filePath = resolveArtifactFile({
        cwd,
        artifactRoot,
        artifacts,
        artifactPath: surface.artifactPath,
      });
      if (!filePath) {
        return {
          name: surface.name,
          artifactPath: surface.artifactPath,
          expectedSha256: surface.expectedSha256,
          actualSha256: "",
          byteForByte: surface.byteForByte,
          status: "failed",
          reason: "artifact-missing",
        };
      }
      const actualSha256 = sha256File(filePath);
      const passed = actualSha256 === surface.expectedSha256;
      return {
        name: surface.name,
        artifactPath: surface.artifactPath,
        expectedSha256: surface.expectedSha256,
        actualSha256,
        byteForByte: surface.byteForByte,
        status: passed ? "passed" : "failed",
        reason: passed ? "" : "digest-mismatch",
      };
    });
    const status = surfaceResults.every((surface) => surface.status === "passed") ? "passed" : "failed";
    return {
      id: witness.id,
      standard: metadata.label,
      standardKey: metadata.key,
      preBuildWitnessSha256,
      witness,
      artifactVerification: {
        status,
        verifiedAt,
        surfaces: surfaceResults,
      },
    };
  });
  const status = worlds.every((world) => world.artifactVerification.status === "passed") ? "passed" : "failed";
  return {
    key: metadata.key,
    passportSection: {
      schemaVersion: 1,
      contract: KFD1_RELEASE_GATE_CONTRACT,
      status,
      metadata: {
        standard: {
          key: metadata.key,
          id: metadata.id,
          label: metadata.label,
          title: metadata.title,
          revision: metadata.revision,
          status: metadata.status,
        },
        schemas: {
          ids: metadata.schemaIds,
          paths: metadata.schemaPaths,
          metadata: metadata.metadataSchema,
        },
        package: metadata.package,
      },
      formatting: BUILDCHAIN_JSON_FORMATTING_POLICY,
      contractWorlds: worlds,
    },
  };
}

export function validateKfd1ReleaseGateEvidence(section, { metadata = resolveKfd1Metadata() } = {}) {
  const issues = [];
  if (!section) {
    return issues;
  }
  if (typeof section !== "object" || Array.isArray(section)) {
    issues.push({
      level: "error",
      code: `${metadata.key}.object`,
      message: `${metadata.key} release gate evidence must be an object`,
      details: {},
    });
    return issues;
  }
  if (section.contract !== KFD1_RELEASE_GATE_CONTRACT) {
    issues.push({
      level: "error",
      code: `${metadata.key}.contract`,
      message: `${metadata.key}.contract must be ${KFD1_RELEASE_GATE_CONTRACT}`,
      details: {},
    });
  }
  if (section.metadata?.standard?.key !== metadata.key) {
    issues.push({
      level: "error",
      code: `${metadata.key}.metadata.standard.key`,
      message: `${metadata.key} metadata key must come from the KFD metadata package`,
      details: { expected: metadata.key, actual: section.metadata?.standard?.key || "" },
    });
  }
  const worlds = Array.isArray(section.contractWorlds) ? section.contractWorlds : [];
  if (worlds.length === 0) {
    issues.push({
      level: "error",
      code: `${metadata.key}.contractWorlds.empty`,
      message: `${metadata.key}.contractWorlds must include at least one witness`,
      details: {},
    });
  }
  for (const [worldIndex, world] of worlds.entries()) {
    if (!world.preBuildWitnessSha256) {
      issues.push({
        level: "error",
        code: `${metadata.key}.contractWorlds[${worldIndex}].preBuildWitnessSha256`,
        message: "KFD-1 contract world must record the frozen pre-build witness digest",
        details: {},
      });
    }
    if (world.standardKey !== metadata.key) {
      issues.push({
        level: "error",
        code: `${metadata.key}.contractWorlds[${worldIndex}].standardKey`,
        message: "KFD-1 contract world standardKey must match KFD metadata",
        details: { expected: metadata.key, actual: world.standardKey || "" },
      });
    }
    if (world.artifactVerification?.status !== "passed") {
      issues.push({
        level: "error",
        code: `${metadata.key}.contractWorlds[${worldIndex}].artifactVerification`,
        message: "KFD-1 artifact verification must pass before release passport finalization",
        details: { id: world.id || "", status: world.artifactVerification?.status || "" },
      });
    }
    const surfaces = Array.isArray(world.artifactVerification?.surfaces) ? world.artifactVerification.surfaces : [];
    if (surfaces.length === 0) {
      issues.push({
        level: "error",
        code: `${metadata.key}.contractWorlds[${worldIndex}].surfaces.empty`,
        message: "KFD-1 artifact verification must list checked surfaces",
        details: { id: world.id || "" },
      });
    }
    for (const [surfaceIndex, surface] of surfaces.entries()) {
      if (surface.status !== "passed" || !surface.expectedSha256 || !surface.actualSha256 || surface.expectedSha256 !== surface.actualSha256) {
        issues.push({
          level: "error",
          code: `${metadata.key}.contractWorlds[${worldIndex}].surfaces[${surfaceIndex}]`,
          message: "KFD-1 verified surface digest mismatch",
          details: {
            id: world.id || "",
            name: surface.name || "",
            artifactPath: surface.artifactPath || "",
            status: surface.status || "",
            reason: surface.reason || "",
          },
        });
      }
    }
  }
  if (section.status !== "passed") {
    issues.push({
      level: "error",
      code: `${metadata.key}.status`,
      message: "KFD-1 release gate status must be passed",
      details: { status: section.status || "" },
    });
  }
  return issues;
}
