import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const KFD1_RELEASE_GATE_CONTRACT = "kungfu-buildchain-kfd-1-release-gate";
export const KFD1_WITNESS_SET_CONTRACT = "kungfu-buildchain-kfd-1-witness-set";
export const KFD3_RELEASE_GATE_CONTRACT = "kungfu-buildchain-kfd-3-collaboration-interface-release-gate";
export const KFD3_PREBUILD_WITNESS_CONTRACT = "kungfu-buildchain-kfd-3-collaboration-interface-prebuild-witness";
export const KFD3_ARTIFACT_WITNESS_CONTRACT = "kungfu-buildchain-kfd-3-collaboration-interface-artifact-witness";
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

export function resolveKfd3Metadata({ requireSchemas = false } = {}) {
  const { packageJson, standards } = loadKfdPackageMetadata();
  const entries = Object.entries(standards.standards || {});
  const entry = entries.find(([key, value]) => {
    const names = [key, value?.key, value?.id, value?.label]
      .filter(Boolean)
      .map((name) => String(name).toLowerCase());
    return names.includes("kfd-3");
  });
  if (!entry) {
    throw new Error("KFD metadata package does not expose KFD-3 metadata");
  }
  const [key, standard] = entry;
  const schemaIds = { ...(standard.schemaIds || {}) };
  const schemaPaths = { ...(standard.schemaPaths || {}) };
  const hasCollaborationSchemas = Boolean(
    schemaIds.collaborationInterface &&
    schemaIds.witness &&
    schemaPaths.collaborationInterface &&
    schemaPaths.witness,
  );
  if (requireSchemas && !hasCollaborationSchemas) {
    throw new Error("KFD metadata package does not expose the KFD-3 collaboration-interface witness standard");
  }
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
    schemaIds,
    schemaPaths,
    hasCollaborationSchemas,
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

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((entry) => optionalString(entry)).filter(Boolean) : [];
}

function normalizeKfd3Surface(surface, index, label) {
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
    throw new Error(`${label}[${index}] must be an object`);
  }
  const visibility = optionalString(surface.visibility || (surface.public === false ? "internal" : "public")).toLowerCase();
  const availability = optionalString(surface.availability || surface.state || surface.maturity || (surface.shipped === false ? "not-shipped" : "shipped")).toLowerCase();
  const participantFacing = surface.participantFacing ?? surface.participant_facing ?? true;
  const publicSurface = surface.public ?? (visibility === "public");
  return {
    id: nonEmptyString(surface.id || surface.name || surface.command, `${label}[${index}].id`),
    name: optionalString(surface.name || surface.label || surface.id),
    kind: optionalString(surface.kind || surface.type || "control-surface"),
    participantProfile: optionalString(surface.participantProfile || surface.participant_profile || surface.profile),
    availability,
    visibility,
    participantFacing: Boolean(participantFacing),
    public: Boolean(publicSurface),
    sourcePath: surface.sourcePath || surface.source_path
      ? normalizePath(surface.sourcePath || surface.source_path, `${label}[${index}].sourcePath`)
      : "",
    evidencePath: surface.evidencePath || surface.evidence_path
      ? normalizePath(surface.evidencePath || surface.evidence_path, `${label}[${index}].evidencePath`)
      : "",
  };
}

function declaredSurfacesFromWitness(witness) {
  if (Array.isArray(witness.declaredSurfaces)) return witness.declaredSurfaces;
  if (Array.isArray(witness.declared_surfaces)) return witness.declared_surfaces;
  if (Array.isArray(witness.surfaces)) return witness.surfaces;
  if (Array.isArray(witness.collaborationInterface?.surfaces)) return witness.collaborationInterface.surfaces;
  if (Array.isArray(witness.collaboration_interface?.surfaces)) return witness.collaboration_interface.surfaces;
  if (Array.isArray(witness.collaborationInterfaceDocument?.surfaces)) return witness.collaborationInterfaceDocument.surfaces;
  if (Array.isArray(witness.collaboration_interface_document?.surfaces)) return witness.collaboration_interface_document.surfaces;
  return [];
}

function artifactSurfacesFromWitness(witness) {
  if (Array.isArray(witness.exposedSurfaces)) return witness.exposedSurfaces;
  if (Array.isArray(witness.exposed_surfaces)) return witness.exposed_surfaces;
  if (Array.isArray(witness.artifactPublicSurfaces)) return witness.artifactPublicSurfaces;
  if (Array.isArray(witness.artifact_public_surfaces)) return witness.artifact_public_surfaces;
  if (Array.isArray(witness.surfaces)) return witness.surfaces;
  if (Array.isArray(witness.closure?.reachableEntrypoints)) {
    return witness.closure.reachableEntrypoints.map((id) => ({
      id,
      kind: "entrypoint",
      availability: "shipped",
      visibility: "public",
      participantFacing: true,
      public: true,
    }));
  }
  return [];
}

function normalizeRegistry(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return {
    id: optionalString(value.id || value.name),
    version: optionalString(value.version),
    path: value.path ? normalizePath(value.path, "registry.path") : "",
    sha256: value.sha256 ? normalizeHash(value.sha256, "registry.sha256") : "",
    digest: optionalString(value.digest || (value.sha256 ? `sha256:${normalizeHash(value.sha256, "registry.sha256")}` : "")),
  };
}

function normalizeArtifactIdentity(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return {
    name: optionalString(value.name || value.fileName || value.filename),
    path: value.path ? normalizePath(value.path, "artifact.path") : "",
    digest: optionalString(value.digest || (value.sha256 ? `sha256:${normalizeHash(value.sha256, "artifact.sha256")}` : "")),
  };
}

export function normalizeKfd3CollaborationInterfacePrebuildWitness(witness, { metadata = resolveKfd3Metadata() } = {}) {
  if (!witness || typeof witness !== "object" || Array.isArray(witness)) {
    throw new Error("KFD-3 pre-build witness must be a JSON object");
  }
  const standard = optionalString(witness.standard || metadata.key);
  if (standard && standard !== metadata.key && standard !== metadata.id && standard !== metadata.label) {
    throw new Error(`KFD-3 witness standard must match ${metadata.key}`);
  }
  const declaredSurfaces = declaredSurfacesFromWitness(witness).map((surface, index) => normalizeKfd3Surface(surface, index, "declaredSurfaces"));
  if (declaredSurfaces.length === 0) {
    throw new Error("KFD-3 pre-build witness must declare at least one collaboration/control surface");
  }
  return {
    schemaVersion: 1,
    contract: KFD3_PREBUILD_WITNESS_CONTRACT,
    id: nonEmptyString(witness.id, "KFD-3 pre-build witness id"),
    standard: metadata.key,
    standardLabel: metadata.label,
    supportLevel: optionalString(witness.supportLevel || witness.support_level || witness.support?.level || "release"),
    source: witness.source && typeof witness.source === "object" && !Array.isArray(witness.source)
      ? { ...witness.source }
      : {},
    registry: normalizeRegistry(witness.registry || witness.sourceRegistry || witness.source_registry || witness.collaborationInterface?.sourceRegistry || witness.collaboration_interface?.sourceRegistry),
    participantProfiles: normalizeStringArray(
      witness.participantProfiles ||
      witness.participant_profiles ||
      witness.profiles ||
      witness.collaborationInterface?.participants?.map((entry) => entry.id || entry.name) ||
      witness.collaboration_interface?.participants?.map((entry) => entry.id || entry.name),
    ),
    expectedArtifactVerification: witness.expectedArtifactVerification && typeof witness.expectedArtifactVerification === "object" && !Array.isArray(witness.expectedArtifactVerification)
      ? { ...witness.expectedArtifactVerification, command: optionalString(witness.expectedArtifactVerification.command) }
      : { command: optionalString(witness.artifactVerifyCommand || witness.artifact_verify_command) },
    collaborationInterfaceDigest: optionalString(
      witness.collaborationInterfaceDigest ||
      witness.collaboration_interface_digest ||
      witness.collaborationInterface?.digest ||
      witness.collaboration_interface?.digest,
    ),
    declaredSurfaces,
    metadata: {
      kfdPackage: metadata.package,
      schemaIds: metadata.schemaIds,
      schemaPaths: metadata.schemaPaths,
      hasCollaborationSchemas: Boolean(metadata.hasCollaborationSchemas),
    },
  };
}

export function normalizeKfd3CollaborationInterfaceArtifactWitness(witness, { metadata = resolveKfd3Metadata() } = {}) {
  if (!witness || typeof witness !== "object" || Array.isArray(witness)) {
    throw new Error("KFD-3 artifact witness must be a JSON object");
  }
  const standard = optionalString(witness.standard || metadata.key);
  if (standard && standard !== metadata.key && standard !== metadata.id && standard !== metadata.label) {
    throw new Error(`KFD-3 artifact witness standard must match ${metadata.key}`);
  }
  const exposedSurfaces = artifactSurfacesFromWitness(witness).map((surface, index) => normalizeKfd3Surface(surface, index, "exposedSurfaces"));
  return {
    schemaVersion: 1,
    contract: KFD3_ARTIFACT_WITNESS_CONTRACT,
    id: nonEmptyString(witness.id, "KFD-3 artifact witness id"),
    standard: metadata.key,
    standardLabel: metadata.label,
    artifact: normalizeArtifactIdentity(witness.artifact),
    registry: normalizeRegistry(witness.registry || witness.sourceRegistry || witness.source_registry),
    collaborationInterfaceDigest: optionalString(
      witness.collaborationInterfaceDigest ||
      witness.collaboration_interface_digest ||
      witness.collaborationInterface?.digest ||
      witness.collaboration_interface?.digest,
    ),
    exposedSurfaces,
    verifier: witness.verifier && typeof witness.verifier === "object" && !Array.isArray(witness.verifier)
      ? { ...witness.verifier }
      : {},
    metadata: {
      kfdPackage: metadata.package,
      schemaIds: metadata.schemaIds,
      schemaPaths: metadata.schemaPaths,
      hasCollaborationSchemas: Boolean(metadata.hasCollaborationSchemas),
    },
  };
}

function isParticipantPublic(surface) {
  return Boolean(surface.public && surface.participantFacing);
}

function isDeclaredShipped(surface) {
  return ["shipped", "stable", "available", "ga", "production"].includes(surface.availability);
}

function isDeclaredPublic(surface) {
  return isParticipantPublic(surface) && !["internal", "unsupported", "not-shipped", "not_shipped"].includes(surface.availability);
}

function idSet(surfaces) {
  return new Set(surfaces.map((surface) => surface.id));
}

function sortedSetDiff(left, right) {
  return [...left].filter((entry) => !right.has(entry)).sort();
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

export function createKfd3CollaborationInterfaceReleaseGateEvidence({
  prebuildWitnesses = [],
  artifactWitnesses = [],
  verifiedAt = new Date().toISOString(),
  metadata = resolveKfd3Metadata(),
} = {}) {
  const normalizedPrebuildWitnesses = (prebuildWitnesses || [])
    .filter(Boolean)
    .map((witness) => normalizeKfd3CollaborationInterfacePrebuildWitness(witness, { metadata }));
  if (normalizedPrebuildWitnesses.length === 0) {
    return undefined;
  }
  const normalizedArtifactWitnesses = (artifactWitnesses || [])
    .filter(Boolean)
    .map((witness) => normalizeKfd3CollaborationInterfaceArtifactWitness(witness, { metadata }));
  const artifactById = new Map(normalizedArtifactWitnesses.map((witness) => [witness.id, witness]));
  const singleArtifactWitness = normalizedArtifactWitnesses.length === 1 ? normalizedArtifactWitnesses[0] : undefined;
  const worlds = normalizedPrebuildWitnesses.map((prebuildWitness) => {
    const artifactWitness = artifactById.get(prebuildWitness.id) || singleArtifactWitness;
    const preBuildWitnessSha256 = sha256Json(prebuildWitness);
    const artifactWitnessSha256 = artifactWitness ? sha256Json(artifactWitness) : "";
    const declaredPublic = prebuildWitness.declaredSurfaces.filter(isDeclaredPublic);
    const declaredShippedPublic = declaredPublic.filter(isDeclaredShipped);
    const artifactPublic = artifactWitness
      ? artifactWitness.exposedSurfaces.filter(isParticipantPublic)
      : [];
    const declaredPublicIds = idSet(declaredPublic);
    const declaredShippedIds = idSet(declaredShippedPublic);
    const artifactPublicIds = idSet(artifactPublic);
    const missingDeclaredShipped = sortedSetDiff(declaredShippedIds, artifactPublicIds);
    const unclassifiedArtifactPublic = sortedSetDiff(artifactPublicIds, declaredPublicIds);
    const reasons = [];
    if (!metadata.hasCollaborationSchemas) {
      reasons.push("kfd-metadata-schema-missing");
    }
    if (!artifactWitness) {
      reasons.push("artifact-witness-missing");
    }
    if (
      prebuildWitness.collaborationInterfaceDigest &&
      artifactWitness?.collaborationInterfaceDigest &&
      prebuildWitness.collaborationInterfaceDigest !== artifactWitness.collaborationInterfaceDigest
    ) {
      reasons.push("collaboration-interface-digest-mismatch");
    }
    if (missingDeclaredShipped.length > 0) {
      reasons.push("declared-shipped-surface-missing");
    }
    if (unclassifiedArtifactPublic.length > 0) {
      reasons.push("artifact-public-surface-not-declared");
    }
    const supportLevel = prebuildWitness.supportLevel || "release";
    if (["draft", "partial", "missing", "unsupported"].includes(supportLevel)) {
      reasons.push(`support-level-${supportLevel}`);
    }
    const status = reasons.length === 0 ? "passed" : supportLevel === "release" ? "failed" : "downgraded";
    return {
      id: prebuildWitness.id,
      standard: metadata.label,
      standardKey: metadata.key,
      preBuildWitnessSha256,
      artifactWitnessSha256,
      prebuildWitness,
      artifactWitness: artifactWitness || undefined,
      comparison: {
        status,
        verifiedAt,
        supportLevel,
        declaredPublicSurfaceCount: declaredPublic.length,
        declaredShippedPublicSurfaceCount: declaredShippedPublic.length,
        artifactPublicSurfaceCount: artifactPublic.length,
        missingDeclaredShipped,
        unclassifiedArtifactPublic,
        reasons,
      },
    };
  });
  const status = worlds.every((world) => world.comparison.status === "passed") ? "passed" : "failed";
  return {
    key: metadata.key,
    passportSection: {
      schemaVersion: 1,
      contract: KFD3_RELEASE_GATE_CONTRACT,
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
          hasCollaborationSchemas: Boolean(metadata.hasCollaborationSchemas),
        },
        package: metadata.package,
      },
      formatting: BUILDCHAIN_JSON_FORMATTING_POLICY,
      collaborationInterfaces: worlds,
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

export function validateKfd3CollaborationInterfaceReleaseGateEvidence(section, { metadata = resolveKfd3Metadata() } = {}) {
  const issues = [];
  if (!section) {
    return issues;
  }
  if (typeof section !== "object" || Array.isArray(section)) {
    issues.push({
      level: "error",
      code: `${metadata.key}.object`,
      message: `${metadata.key} collaboration-interface evidence must be an object`,
      details: {},
    });
    return issues;
  }
  if (section.contract !== KFD3_RELEASE_GATE_CONTRACT) {
    issues.push({
      level: "error",
      code: `${metadata.key}.contract`,
      message: `${metadata.key}.contract must be ${KFD3_RELEASE_GATE_CONTRACT}`,
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
  if (!section.metadata?.schemas?.hasCollaborationSchemas) {
    issues.push({
      level: "error",
      code: `${metadata.key}.metadata.schemas.collaborationInterface`,
      message: "KFD-3 release evidence requires KFD package metadata for collaboration-interface and witness schemas",
      details: { package: metadata.package, schemaIds: section.metadata?.schemas?.ids || {} },
    });
  }
  const interfaces = Array.isArray(section.collaborationInterfaces) ? section.collaborationInterfaces : [];
  if (interfaces.length === 0) {
    issues.push({
      level: "error",
      code: `${metadata.key}.collaborationInterfaces.empty`,
      message: `${metadata.key}.collaborationInterfaces must include at least one witness pair`,
      details: {},
    });
  }
  for (const [index, entry] of interfaces.entries()) {
    if (!entry.preBuildWitnessSha256) {
      issues.push({
        level: "error",
        code: `${metadata.key}.collaborationInterfaces[${index}].preBuildWitnessSha256`,
        message: "KFD-3 collaboration-interface evidence must record the frozen pre-build witness digest",
        details: {},
      });
    }
    if (!entry.artifactWitnessSha256) {
      issues.push({
        level: "error",
        code: `${metadata.key}.collaborationInterfaces[${index}].artifactWitnessSha256`,
        message: "KFD-3 collaboration-interface evidence must record the artifact-side witness digest",
        details: { id: entry.id || "" },
      });
    }
    if (entry.standardKey !== metadata.key) {
      issues.push({
        level: "error",
        code: `${metadata.key}.collaborationInterfaces[${index}].standardKey`,
        message: "KFD-3 collaboration-interface standardKey must match KFD metadata",
        details: { expected: metadata.key, actual: entry.standardKey || "" },
      });
    }
    const comparison = entry.comparison || {};
    if (comparison.status !== "passed") {
      issues.push({
        level: "error",
        code: `${metadata.key}.collaborationInterfaces[${index}].comparison`,
        message: "KFD-3 collaboration-interface artifact closure verification must pass before release passport finalization",
        details: {
          id: entry.id || "",
          status: comparison.status || "",
          reasons: comparison.reasons || [],
        },
      });
    }
    if (Array.isArray(comparison.missingDeclaredShipped) && comparison.missingDeclaredShipped.length > 0) {
      issues.push({
        level: "error",
        code: `${metadata.key}.collaborationInterfaces[${index}].missingDeclaredShipped`,
        message: "KFD-3 artifact is missing declared shipped public surfaces",
        details: { id: entry.id || "", surfaces: comparison.missingDeclaredShipped },
      });
    }
    if (Array.isArray(comparison.unclassifiedArtifactPublic) && comparison.unclassifiedArtifactPublic.length > 0) {
      issues.push({
        level: "error",
        code: `${metadata.key}.collaborationInterfaces[${index}].unclassifiedArtifactPublic`,
        message: "KFD-3 artifact exposes public participant-facing surfaces not declared by the pre-build witness",
        details: { id: entry.id || "", surfaces: comparison.unclassifiedArtifactPublic },
      });
    }
  }
  if (section.status !== "passed") {
    issues.push({
      level: "error",
      code: `${metadata.key}.status`,
      message: "KFD-3 collaboration-interface release gate status must be passed",
      details: { status: section.status || "" },
    });
  }
  return issues;
}
