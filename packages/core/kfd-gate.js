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

function tryReadJsonPackageExport(exportPath) {
  try {
    return readJsonPackageExport(exportPath);
  } catch {
    return undefined;
  }
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

export function resolveKfd2Metadata({ requireTrustTaxonomy = false } = {}) {
  const { packageJson, standards } = loadKfdPackageMetadata();
  const entries = Object.entries(standards.standards || {});
  const entry = entries.find(([key, value]) => {
    const names = [key, value?.key, value?.id, value?.label]
      .filter(Boolean)
      .map((name) => String(name).toLowerCase());
    return names.includes("kfd-2");
  });
  if (!entry) {
    throw new Error("KFD metadata package does not expose KFD-2 metadata");
  }
  const [key, standard] = entry;
  const schemaIds = { ...(standard.schemaIds || {}) };
  const schemaPaths = { ...(standard.schemaPaths || {}) };
  const trustTaxonomyPath = schemaPaths.trustTaxonomy || "";
  const trustTaxonomy = trustTaxonomyPath
    ? tryReadJsonPackageExport(`@kungfu-tech/kfd/${trustTaxonomyPath}`)
    : undefined;
  if (requireTrustTaxonomy && (!schemaIds.trustTaxonomy || !trustTaxonomyPath || !trustTaxonomy)) {
    throw new Error("KFD metadata package does not expose the KFD-2 trust taxonomy schema");
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
    hasTrustTaxonomySchema: Boolean(schemaIds.trustTaxonomy && trustTaxonomyPath && trustTaxonomy),
    trustTaxonomy,
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

const KFD3_SURFACE_GROUPS = [
  {
    kind: "documentation",
    keys: ["docs", "documents", "documentation"],
  },
  {
    kind: "schema",
    keys: ["schemas"],
  },
  {
    kind: "standards-metadata",
    keys: ["standardsMetadata", "standards_metadata", "standards", "metadata"],
  },
  {
    kind: "package-export",
    keys: ["packageExports", "package_exports", "exports"],
  },
  {
    kind: "site-consumption-contract",
    keys: ["siteConsumptionContracts", "site_consumption_contracts", "siteContracts", "site_contracts"],
  },
];

function groupedKfd3SurfacesFromSource(source = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return [];
  }
  const surfaces = [];
  for (const group of KFD3_SURFACE_GROUPS) {
    const values = group.keys
      .map((key) => source[key])
      .find((entry) => Array.isArray(entry));
    if (!values) {
      continue;
    }
    values.forEach((entry, index) => {
      if (typeof entry === "string") {
        surfaces.push({
          id: entry,
          name: entry,
          kind: group.kind,
          availability: "shipped",
          visibility: "public",
          participantFacing: true,
          public: true,
        });
        return;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`${group.keys[0]}[${index}] must be a string or object`);
      }
      surfaces.push({
        kind: group.kind,
        availability: "shipped",
        visibility: "public",
        participantFacing: true,
        public: true,
        ...entry,
      });
    });
  }
  return surfaces;
}

function groupedKfd1SurfacesFromSource(source = {}) {
  return groupedKfd3SurfacesFromSource(source).map((surface) => ({
    name: surface.name || surface.id,
    sourcePath: surface.sourcePath || surface.source_path || "",
    sourceSha256: surface.sourceSha256 || surface.source_sha256 || surface.sha256 || "",
    artifactPath: surface.artifactPath || surface.artifact_path || surface.path || surface.sourcePath || surface.source_path || "",
    expectedSha256: surface.expectedSha256 || surface.expected_sha256 || surface.artifactSha256 || surface.artifact_sha256 || surface.sha256 || "",
    byteForByte: surface.byteForByte ?? surface.byte_for_byte ?? true,
  }));
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
  return [
    ...(Array.isArray(witness.declaredSurfaces) ? witness.declaredSurfaces : []),
    ...(Array.isArray(witness.declared_surfaces) ? witness.declared_surfaces : []),
    ...(Array.isArray(witness.surfaces) ? witness.surfaces : []),
    ...(Array.isArray(witness.collaborationInterface?.surfaces) ? witness.collaborationInterface.surfaces : []),
    ...(Array.isArray(witness.collaboration_interface?.surfaces) ? witness.collaboration_interface.surfaces : []),
    ...(Array.isArray(witness.collaborationInterfaceDocument?.surfaces) ? witness.collaborationInterfaceDocument.surfaces : []),
    ...(Array.isArray(witness.collaboration_interface_document?.surfaces) ? witness.collaboration_interface_document.surfaces : []),
    ...groupedKfd3SurfacesFromSource(witness),
    ...groupedKfd3SurfacesFromSource(witness.collaborationInterface),
    ...groupedKfd3SurfacesFromSource(witness.collaboration_interface),
    ...groupedKfd3SurfacesFromSource(witness.collaborationInterfaceDocument),
    ...groupedKfd3SurfacesFromSource(witness.collaboration_interface_document),
  ];
}

function artifactSurfacesFromWitness(witness) {
  const groupedSurfaces = [
    ...groupedKfd3SurfacesFromSource(witness),
    ...groupedKfd3SurfacesFromSource(witness.artifact),
    ...groupedKfd3SurfacesFromSource(witness.closure),
  ];
  const explicitSurfaces = [
    ...(Array.isArray(witness.exposedSurfaces) ? witness.exposedSurfaces : []),
    ...(Array.isArray(witness.exposed_surfaces) ? witness.exposed_surfaces : []),
    ...(Array.isArray(witness.artifactPublicSurfaces) ? witness.artifactPublicSurfaces : []),
    ...(Array.isArray(witness.artifact_public_surfaces) ? witness.artifact_public_surfaces : []),
    ...(Array.isArray(witness.surfaces) ? witness.surfaces : []),
  ];
  if (Array.isArray(witness.closure?.reachableEntrypoints)) {
    explicitSurfaces.push(...witness.closure.reachableEntrypoints.map((id) => ({
      id,
      kind: "entrypoint",
      availability: "shipped",
      visibility: "public",
      participantFacing: true,
      public: true,
    })));
  }
  return [...explicitSurfaces, ...groupedSurfaces];
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

function normalizeStringObjectArray(value, label) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry, index) => {
      if (typeof entry === "string") {
        return { id: entry, note: "" };
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`${label}[${index}] must be a string or object`);
      }
      return {
        ...entry,
        id: optionalString(entry.id || entry.name || entry.surface || entry.path || entry.kind || `entry-${index}`),
        kind: optionalString(entry.kind || entry.type),
        reason: optionalString(entry.reason || entry.rationale || entry.note || entry.description),
        owner: optionalString(entry.owner),
      };
    })
    .filter((entry) => entry.id || entry.reason);
}

const KFD2_TAXONOMY_FIELDS = ["riskType", "trustImpact", "machineProvability", "agentAction"];

function kfdExtensionGuidance({ taxonomy = undefined, extensionRequests = [] } = {}) {
  const requestPath = taxonomy?.["x-kfd"]?.extensionPolicy?.requestPath || {};
  const kfd3Request = Array.isArray(extensionRequests)
    ? extensionRequests.find((entry) => entry?.requestPath?.kind === "github-issue")
    : undefined;
  return {
    action: taxonomy?.["x-kfd"]?.extensionPolicy?.standardAction || "open-kfd-extension-issue",
    repository: requestPath.repository || kfd3Request?.requestPath?.target || "https://github.com/kungfu-systems/kfd",
    issueUrl: requestPath.issueUrl || kfd3Request?.requestPath?.template || "https://github.com/kungfu-systems/kfd/issues/new?title=KFD-2%20trust%20taxonomy%20extension%20request",
    appliesTo: requestPath.appliesTo || KFD2_TAXONOMY_FIELDS,
  };
}

function taxonomyAllowedValues(taxonomy = {}) {
  const xKfd = taxonomy?.["x-kfd"]?.allowedValues || {};
  const defs = taxonomy?.$defs || {};
  return {
    riskType: new Set(xKfd.riskType || defs.riskType?.enum || []),
    trustImpact: new Set(xKfd.trustImpact || defs.trustImpact?.enum || []),
    machineProvability: new Set(xKfd.machineProvability || defs.machineProvability?.enum || []),
    agentAction: new Set(xKfd.agentAction || defs.agentAction?.enum || []),
  };
}

function validateTaxonomyField(entry, field, { allowed, label, guidance }) {
  const value = optionalString(entry[field]).trim();
  if (!value) {
    throw new Error(`${label}.${field} is required by KFD-2 trust taxonomy; do not invent a local private value, ${guidance.action} at ${guidance.issueUrl}`);
  }
  if (!allowed[field]?.has(value)) {
    throw new Error(`${label}.${field}=${value} is not in KFD-2 trust taxonomy; unknown taxonomy values fail validation, ${guidance.action} at ${guidance.issueUrl}`);
  }
}

export function validateKfd2TrustTaxonomyEntry(entry, {
  kind = "residualRisk",
  label = kind,
  metadata = resolveKfd2Metadata({ requireTrustTaxonomy: true }),
  extensionRequests = [],
} = {}) {
  const taxonomy = metadata.trustTaxonomy;
  const taxonomyContract = taxonomy?.contract || taxonomy?.["x-kfd"]?.contract;
  if (!taxonomy || taxonomyContract !== "kfd-2-trust-taxonomy") {
    const guidance = kfdExtensionGuidance({ taxonomy, extensionRequests });
    throw new Error(`${label} requires KFD-2 trust taxonomy from @kungfu-tech/kfd standards.json; ${guidance.action} at ${guidance.issueUrl}`);
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${label} must be an object validated by KFD-2 trust taxonomy`);
  }
  const guidance = kfdExtensionGuidance({ taxonomy, extensionRequests });
  const defs = taxonomy.$defs || {};
  const required = defs[kind]?.required || (kind === "residualRisk"
    ? ["id", "definedBy", "riskType", "trustImpact", "machineProvability", "agentAction", "reason", "owner"]
    : ["id", "riskType", "trustImpact", "reason"]);
  for (const field of required) {
    if (!optionalString(entry[field]).trim()) {
      throw new Error(`${label}.${field} is required by KFD-2 trust taxonomy; do not add a private local taxonomy value, ${guidance.action} at ${guidance.issueUrl}`);
    }
  }
  const allowed = taxonomyAllowedValues(taxonomy);
  for (const field of KFD2_TAXONOMY_FIELDS) {
    if (field in entry || required.includes(field)) {
      validateTaxonomyField(entry, field, { allowed, label, guidance });
    }
  }
  if (kind === "residualRisk") {
    const expectedDefinedBy = `${metadata.schemaIds.trustTaxonomy}#/$defs/residualRisk`;
    if (entry.definedBy !== expectedDefinedBy) {
      throw new Error(`${label}.definedBy must be ${expectedDefinedBy}; ${guidance.action} at ${guidance.issueUrl}`);
    }
  }
  return {
    ...entry,
    taxonomy: {
      standard: metadata.key,
      schemaId: metadata.schemaIds.trustTaxonomy,
      schemaPath: metadata.schemaPaths.trustTaxonomy,
      contract: taxonomyContract,
      package: metadata.package,
    },
    extensionRequest: entry.extensionRequest || kfdExtensionGuidance({ taxonomy, extensionRequests }),
  };
}

function normalizeKfd2TaxonomyEntries(value, {
  kind = "residualRisk",
  label = kind,
  extensionRequests = [],
} = {}) {
  const entries = normalizeStringObjectArray(value, label);
  if (entries.length === 0) {
    return [];
  }
  const metadata = resolveKfd2Metadata({ requireTrustTaxonomy: true });
  return entries.map((entry, index) => validateKfd2TrustTaxonomyEntry(entry, {
    kind,
    label: `${label}[${index}]`,
    metadata,
    extensionRequests,
  }));
}

function normalizeKfd3AuditBoundary(value = {}, { closure = {}, label = "auditBoundary" } = {}) {
  const boundary = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceClosure = closure && typeof closure === "object" && !Array.isArray(closure) ? closure : {};
  const nonExhaustiveSource =
    boundary.nonExhaustivelyEnumerableSurfaces ||
    boundary.non_exhaustively_enumerable_surfaces ||
    boundary.nonExhaustiveSurfaces ||
    boundary.non_exhaustive_surfaces ||
    sourceClosure.nonExhaustivelyEnumerableSurfaces ||
    sourceClosure.non_exhaustively_enumerable_surfaces ||
    sourceClosure.nonExhaustiveSurfaces ||
    sourceClosure.non_exhaustive_surfaces ||
    [];
  return {
    mode: optionalString(boundary.mode || boundary.classificationMode || sourceClosure.classificationMode || "closed-world"),
    scope: optionalString(boundary.scope || "participant-facing public collaboration/control surfaces"),
    reachableSurfaceMode: optionalString(
      boundary.reachableSurfaceMode ||
      boundary.reachable_surface_mode ||
      sourceClosure.reachableSurfaceMode ||
      sourceClosure.reachable_surface_mode ||
      sourceClosure.classificationMode ||
      "declared-boundary",
    ),
    unclassifiedPolicy: optionalString(
      boundary.unclassifiedPolicy ||
      boundary.unclassified_policy ||
      sourceClosure.unclassifiedEntrypointsPolicy ||
      sourceClosure.unclassified_entrypoints_policy ||
      "fail",
    ),
    nonExhaustivelyEnumerableSurfaces: normalizeStringObjectArray(nonExhaustiveSource, `${label}.nonExhaustivelyEnumerableSurfaces`),
    explicitlyExemptedSurfaces: normalizeStringObjectArray(
      boundary.explicitlyExemptedSurfaces ||
      boundary.explicitly_exempted_surfaces ||
      boundary.exemptions ||
      sourceClosure.explicitlyExemptedSurfaces ||
      sourceClosure.exemptions ||
      [],
      `${label}.explicitlyExemptedSurfaces`,
    ),
  };
}

function normalizeKfd3ResidualRisk(value = [], { auditBoundary = {}, extensionRequests = [] } = {}) {
  const explicitRisks = normalizeStringObjectArray(value, "residualRisk");
  const boundaryRisks = (auditBoundary.nonExhaustivelyEnumerableSurfaces || []).map((entry) => ({
    ...entry,
    id: entry.id,
    kind: entry.kind || "non-exhaustive-surface",
    reason: entry.reason || "Surface cannot be exhaustively enumerated by the release passport.",
    owner: entry.owner || "",
  }));
  const byId = new Map();
  for (const entry of [...explicitRisks, ...boundaryRisks]) {
    byId.set(entry.id || entry.reason, entry);
  }
  return normalizeKfd2TaxonomyEntries([...byId.values()], {
    kind: "residualRisk",
    label: "residualRisk",
    extensionRequests,
  });
}

function normalizeKfd3Responsibility(value = {}, { registry = {}, artifactVerifyCommand = "" } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    registryFactsOwner: optionalString(
      source.registryFactsOwner ||
      source.registry_facts_owner ||
      source.productRegistryOwner ||
      source.product_registry_owner ||
      source.product ||
      registry.id ||
      "product",
    ),
    artifactVerificationOwner: optionalString(
      source.artifactVerificationOwner ||
      source.artifact_verification_owner ||
      source.verifierOwner ||
      source.verifier_owner ||
      (artifactVerifyCommand ? "product-owned verify command" : "product"),
    ),
    releasePassportProofOwner: optionalString(
      source.releasePassportProofOwner ||
      source.release_passport_proof_owner ||
      source.passportOwner ||
      source.passport_owner ||
      "buildchain",
    ),
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
  const registry = normalizeRegistry(witness.registry || witness.sourceRegistry || witness.source_registry || witness.collaborationInterface?.sourceRegistry || witness.collaboration_interface?.sourceRegistry);
  const closure = witness.collaborationInterface?.closure || witness.collaboration_interface?.closure || {};
  const extensionRequests = normalizeStringObjectArray(
    witness.extensionRequests ||
      witness.extension_requests ||
      witness.collaborationInterface?.extensionRequests ||
      witness.collaboration_interface?.extensionRequests ||
      [],
    "extensionRequests",
  );
  const auditBoundary = normalizeKfd3AuditBoundary(witness.auditBoundary || witness.audit_boundary || closure, { closure });
  const expectedArtifactVerification = witness.expectedArtifactVerification && typeof witness.expectedArtifactVerification === "object" && !Array.isArray(witness.expectedArtifactVerification)
    ? { ...witness.expectedArtifactVerification, command: optionalString(witness.expectedArtifactVerification.command) }
    : { command: optionalString(witness.artifactVerifyCommand || witness.artifact_verify_command) };
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
    registry,
    participantProfiles: normalizeStringArray(
      witness.participantProfiles ||
      witness.participant_profiles ||
      witness.profiles ||
      witness.collaborationInterface?.participants?.map((entry) => entry.id || entry.name) ||
      witness.collaboration_interface?.participants?.map((entry) => entry.id || entry.name),
    ),
    expectedArtifactVerification,
    collaborationInterfaceDigest: optionalString(
      witness.collaborationInterfaceDigest ||
      witness.collaboration_interface_digest ||
      witness.collaborationInterface?.digest ||
      witness.collaboration_interface?.digest,
    ),
    auditBoundary,
    residualRisk: normalizeKfd3ResidualRisk(
      witness.residualRisk || witness.residual_risk || witness.auditBoundary?.residualRisk || witness.audit_boundary?.residual_risk || [],
      { auditBoundary, extensionRequests },
    ),
    extensionRequests,
    responsibility: normalizeKfd3Responsibility(witness.responsibility || witness.owners, {
      registry,
      artifactVerifyCommand: expectedArtifactVerification.command,
    }),
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
  const extensionRequests = normalizeStringObjectArray(
    witness.extensionRequests || witness.extension_requests || [],
    "extensionRequests",
  );
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
    residualRisk: normalizeKfd2TaxonomyEntries(witness.residualRisk || witness.residual_risk || [], {
      kind: "residualRisk",
      label: "artifactWitness.residualRisk",
      extensionRequests,
    }),
    extensionRequests,
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

function kfd3ReleaseStatus({ comparisonStatus, supportLevel, residualRisk = [] } = {}) {
  if (comparisonStatus === "passed") {
    return residualRisk.length > 0 ? "audited" : "enforced";
  }
  if (["draft", "partial", "missing", "unsupported"].includes(supportLevel)) {
    return "draft";
  }
  return "declared";
}

function kfd3TrustResult(comparisonStatus) {
  if (comparisonStatus === "passed") return "pass";
  if (comparisonStatus === "downgraded") return "downgraded";
  return "fail";
}

function kfd3TrustStatement({
  comparisonStatus,
  missingDeclaredShipped = [],
  unclassifiedArtifactPublic = [],
  residualRisk = [],
} = {}) {
  if (comparisonStatus === "passed") {
    return unclassifiedArtifactPublic.length === 0
      ? "No unclassified reachable surface within the declared audit boundary."
      : "Unclassified reachable surfaces remain within the declared audit boundary.";
  }
  if (missingDeclaredShipped.length > 0) {
    return "One or more declared shipped public surfaces are missing from the artifact evidence.";
  }
  if (unclassifiedArtifactPublic.length > 0) {
    return "The artifact exposes participant-facing public surfaces not declared by the pre-build witness.";
  }
  if (residualRisk.length > 0) {
    return "KFD-3 proof is downgraded and residual risks remain explicit.";
  }
  return "KFD-3 collaboration-interface proof did not pass.";
}

function evidenceDescriptor({ path = "", sha256 = "", canonicalSha256 = "" } = {}) {
  return {
    path: optionalString(path),
    sha256: optionalString(sha256),
    canonicalSha256: optionalString(canonicalSha256),
  };
}

function kfd1SurfacesFromWitness(witness = {}) {
  return [
    ...(Array.isArray(witness.surfaces) ? witness.surfaces : []),
    ...groupedKfd1SurfacesFromSource(witness),
    ...groupedKfd1SurfacesFromSource(witness.standardContract),
    ...groupedKfd1SurfacesFromSource(witness.standard_contract),
    ...groupedKfd1SurfacesFromSource(witness.selfContract),
    ...groupedKfd1SurfacesFromSource(witness.self_contract),
    ...groupedKfd1SurfacesFromSource(witness.contractWorld),
  ];
}

function normalizeKfd1SelfHostingBoundary(value = {}, { contractWorld = {} } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    mode: optionalString(source.mode || (source.enabled || contractWorld.selfHosted ? "self-hosted-standard-contract" : "external-contract-world")),
    sourceScope: optionalString(source.sourceScope || source.source_scope || "KFD source standard metadata, schemas, package exports, and site-consumption entrypoints"),
    artifactScope: optionalString(source.artifactScope || source.artifact_scope || "packaged public artifact surfaces"),
    boundary: optionalString(source.boundary || "source-to-artifact byte equality for declared standard-contract surfaces"),
    residualRisk: normalizeStringObjectArray(
      source.residualRisk || source.residual_risk || source.nonEnumerableResidualRisk || source.non_enumerable_residual_risk || [],
      "selfHostingBoundary.residualRisk",
    ),
  };
}

function normalizeKfd1Responsibility(value = {}, { contractWorld = {} } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    sourceContractOwner: optionalString(source.sourceContractOwner || source.source_contract_owner || source.standardOwner || source.standard_owner || contractWorld.owner || "product"),
    artifactVerificationOwner: optionalString(source.artifactVerificationOwner || source.artifact_verification_owner || "buildchain-release-passport"),
    releasePassportProofOwner: optionalString(source.releasePassportProofOwner || source.release_passport_proof_owner || "buildchain"),
  };
}

function normalizeKfd1StandardContract(value = {}, { metadata = resolveKfd1Metadata() } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    id: optionalString(source.id || source.name),
    schemaId: optionalString(source.schemaId || source.schema_id || metadata.schemaIds.contractWorld),
    path: source.path ? normalizePath(source.path, "standardContract.path") : "",
    sha256: source.sha256 ? normalizeHash(source.sha256, "standardContract.sha256") : "",
    digest: optionalString(source.digest || (source.sha256 ? `sha256:${normalizeHash(source.sha256, "standardContract.sha256")}` : "")),
  };
}

export function normalizeKfd1ContractWorldWitness(witness, { metadata = resolveKfd1Metadata() } = {}) {
  if (!witness || typeof witness !== "object" || Array.isArray(witness)) {
    throw new Error("KFD-1 witness must be a JSON object");
  }
  const surfaces = kfd1SurfacesFromWitness(witness).map((surface, index) => normalizeSurface(surface, index));
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
    standardContract: normalizeKfd1StandardContract(witness.standardContract || witness.standard_contract || witness.selfContract || witness.self_contract || witness.contractWorld, { metadata }),
    selfHostingBoundary: normalizeKfd1SelfHostingBoundary(witness.selfHostingBoundary || witness.self_hosting_boundary, {
      contractWorld: witness.contractWorld,
    }),
    responsibility: normalizeKfd1Responsibility(witness.responsibility || witness.owners, {
      contractWorld: witness.contractWorld,
    }),
    sourceVerificationRequired: Boolean(witness.standardContract || witness.standard_contract || witness.selfContract || witness.self_contract || witness.selfHostingBoundary || witness.self_hosting_boundary),
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

function resolveSourceFile({ cwd, sourcePath }) {
  if (!sourcePath) {
    return "";
  }
  const candidate = path.resolve(cwd, sourcePath);
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : "";
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
    const sourceResults = witness.surfaces.map((surface) => {
      if (!surface.sourcePath || !surface.sourceSha256) {
        return {
          name: surface.name,
          sourcePath: surface.sourcePath,
          expectedSha256: surface.sourceSha256,
          actualSha256: "",
          status: witness.sourceVerificationRequired ? "failed" : "not-declared",
          reason: witness.sourceVerificationRequired ? "source-digest-not-declared" : "",
        };
      }
      const filePath = resolveSourceFile({ cwd, sourcePath: surface.sourcePath });
      if (!filePath) {
        return {
          name: surface.name,
          sourcePath: surface.sourcePath,
          expectedSha256: surface.sourceSha256,
          actualSha256: "",
          status: witness.sourceVerificationRequired ? "failed" : "unavailable",
          reason: "source-missing",
        };
      }
      const actualSha256 = sha256File(filePath);
      const passed = actualSha256 === surface.sourceSha256;
      return {
        name: surface.name,
        sourcePath: surface.sourcePath,
        expectedSha256: surface.sourceSha256,
        actualSha256,
        status: passed ? "passed" : "failed",
        reason: passed ? "" : "source-digest-mismatch",
      };
    });
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
          sourcePath: surface.sourcePath,
          sourceSha256: surface.sourceSha256,
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
        sourcePath: surface.sourcePath,
        sourceSha256: surface.sourceSha256,
        artifactPath: surface.artifactPath,
        expectedSha256: surface.expectedSha256,
        actualSha256,
        byteForByte: surface.byteForByte,
        status: passed ? "passed" : "failed",
        reason: passed ? "" : "digest-mismatch",
      };
    });
    const status = surfaceResults.every((surface) => surface.status === "passed") ? "passed" : "failed";
    const sourceStatus = sourceResults.every((surface) => ["passed", "not-declared", "unavailable"].includes(surface.status)) &&
      (!witness.sourceVerificationRequired || sourceResults.every((surface) => surface.status === "passed"))
      ? "passed"
      : "failed";
    const worldStatus = status === "passed" && sourceStatus === "passed" ? "passed" : "failed";
    return {
      id: witness.id,
      standard: metadata.label,
      standardKey: metadata.key,
      result: worldStatus,
      preBuildWitnessSha256,
      sourceHashes: {
        sha256: sha256Json(sourceResults),
        surfaceCount: sourceResults.length,
      },
      artifactHashes: {
        sha256: sha256Json(surfaceResults),
        surfaceCount: surfaceResults.length,
      },
      witness,
      standardContract: witness.standardContract,
      selfHostingBoundary: witness.selfHostingBoundary,
      responsibility: witness.responsibility,
      sourceVerification: {
        status: sourceStatus,
        verifiedAt,
        required: Boolean(witness.sourceVerificationRequired),
        surfaces: sourceResults,
      },
      artifactVerification: {
        status,
        verifiedAt,
        surfaces: surfaceResults,
      },
    };
  });
  const status = worlds.every((world) => world.result === "passed") ? "passed" : "failed";
  return {
    key: metadata.key,
    passportSection: {
      schemaVersion: 1,
      contract: KFD1_RELEASE_GATE_CONTRACT,
      status,
      selfContractVerification: {
        result: status === "passed" ? "pass" : "fail",
        contractWorldCount: worlds.length,
        selfHosted: worlds.some((world) => world.sourceVerification.required),
        responsibility: {
          proofOwner: "buildchain-release-passport",
        },
      },
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
  prebuildWitnessMetas = [],
  artifactWitnessMetas = [],
  artifactCommandMeta = undefined,
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
  const prebuildMetaById = new Map((prebuildWitnessMetas || [])
    .filter((meta) => meta?.value?.id)
    .map((meta) => [meta.value.id, meta]));
  const artifactMetaById = new Map((artifactWitnessMetas || [])
    .filter((meta) => meta?.value?.id)
    .map((meta) => [meta.value.id, meta]));
  const singleArtifactMeta = (artifactWitnessMetas || []).filter((meta) => meta?.value).length === 1
    ? (artifactWitnessMetas || []).find((meta) => meta?.value)
    : undefined;
  const worlds = normalizedPrebuildWitnesses.map((prebuildWitness) => {
    const artifactWitness = artifactById.get(prebuildWitness.id) || singleArtifactWitness;
    const prebuildMeta = prebuildMetaById.get(prebuildWitness.id) || {};
    const artifactMeta = artifactWitness ? (artifactMetaById.get(artifactWitness.id) || singleArtifactMeta || artifactCommandMeta || {}) : {};
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
    const residualRiskMap = new Map();
    for (const risk of [...(prebuildWitness.residualRisk || []), ...(artifactWitness?.residualRisk || [])]) {
      residualRiskMap.set(risk.id || risk.reason, risk);
    }
    const residualRisk = [...residualRiskMap.values()];
    const releaseStatus = kfd3ReleaseStatus({ comparisonStatus: status, supportLevel, residualRisk });
    const trustResult = kfd3TrustResult(status);
    const declaredCapabilityVerification = {
      status,
      result: missingDeclaredShipped.length === 0 ? "passed" : "failed",
      declaredCapabilityCount: declaredPublic.length,
      declaredShippedPublicSurfaceCount: declaredShippedPublic.length,
      implementedPublicSurfaceCount: artifactPublic.length,
      missingDeclaredShipped,
    };
    const reverseAudit = {
      status: unclassifiedArtifactPublic.length === 0 ? "passed" : "failed",
      auditBoundary: prebuildWitness.auditBoundary,
      reachablePublicSurfaceCount: artifactPublic.length,
      unclassifiedReachableSurfaces: unclassifiedArtifactPublic,
      explicitlyExemptedSurfaces: prebuildWitness.auditBoundary.explicitlyExemptedSurfaces,
      nonExhaustivelyEnumerableSurfaces: prebuildWitness.auditBoundary.nonExhaustivelyEnumerableSurfaces,
      statement: unclassifiedArtifactPublic.length === 0
        ? "No unclassified reachable surface within the declared audit boundary."
        : "Unclassified reachable surfaces were found within the declared audit boundary.",
    };
    const witnessEvidence = {
      prebuild: evidenceDescriptor({
        path: prebuildMeta.path,
        sha256: prebuildMeta.sha256,
        canonicalSha256: preBuildWitnessSha256,
      }),
      artifact: evidenceDescriptor({
        path: artifactMeta.path,
        sha256: artifactMeta.sha256,
        canonicalSha256: artifactWitnessSha256,
      }),
      artifactVerifyCommandSha256: optionalString(artifactCommandMeta?.sha256),
    };
    return {
      id: prebuildWitness.id,
      standard: metadata.label,
      standardKey: metadata.key,
      preBuildWitnessSha256,
      artifactWitnessSha256,
      prebuildWitness,
      artifactWitness: artifactWitness || undefined,
      declaredSurfaces: prebuildWitness.declaredSurfaces,
      exposedSurfaces: artifactPublic,
      factSource: {
        role: "product-owned",
        registry: prebuildWitness.registry,
        collaborationInterfaceDigest: prebuildWitness.collaborationInterfaceDigest,
      },
      witnessEvidence,
      auditBoundary: prebuildWitness.auditBoundary,
      residualRisk,
      responsibility: prebuildWitness.responsibility,
      releaseStatus,
      trustProof: {
        contract: "kungfu-buildchain-kfd-3-passport-trust-proof",
        result: trustResult,
        releaseStatus,
        statement: kfd3TrustStatement({
          comparisonStatus: status,
          missingDeclaredShipped,
          unclassifiedArtifactPublic,
          residualRisk,
        }),
        factSourceRole: "product-owned-registry-and-witnesses",
        proofOwner: "buildchain-release-passport",
        declaredCapabilityVerification,
        reverseAudit,
        residualRisk,
        responsibility: prebuildWitness.responsibility,
      },
      declaredCapabilityVerification,
      reverseAudit,
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
  const releaseStatuses = [...new Set(worlds.map((world) => world.releaseStatus))];
  const trustResult = status === "passed" ? "pass" : worlds.some((world) => world.trustProof.result === "downgraded") ? "downgraded" : "fail";
  return {
    key: metadata.key,
    passportSection: {
      schemaVersion: 1,
      contract: KFD3_RELEASE_GATE_CONTRACT,
      status,
      releaseStatus: releaseStatuses.length === 1 ? releaseStatuses[0] : status === "passed" ? "audited" : "declared",
      trustProof: {
        contract: "kungfu-buildchain-kfd-3-passport-trust-proof",
        result: trustResult,
        statement: status === "passed"
          ? "No unclassified reachable surface within the declared audit boundary."
          : "One or more KFD-3 collaboration-interface witness pairs failed or downgraded.",
        factSourceRole: "product-owned-registry-and-witnesses",
        proofOwner: "buildchain-release-passport",
        collaborationInterfaceCount: worlds.length,
        audited: worlds.every((world) => world.trustProof.result === "pass"),
      },
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
    if (!world.sourceHashes?.sha256 || !world.artifactHashes?.sha256) {
      issues.push({
        level: "error",
        code: `${metadata.key}.contractWorlds[${worldIndex}].hashes`,
        message: "KFD-1 self contract evidence must record source and artifact hash summaries",
        details: { id: world.id || "" },
      });
    }
    if (!world.selfHostingBoundary || typeof world.selfHostingBoundary !== "object" || Array.isArray(world.selfHostingBoundary)) {
      issues.push({
        level: "error",
        code: `${metadata.key}.contractWorlds[${worldIndex}].selfHostingBoundary`,
        message: "KFD-1 contract world must record the self-hosting boundary",
        details: { id: world.id || "" },
      });
    }
    if (!world.responsibility?.sourceContractOwner || !world.responsibility?.artifactVerificationOwner || !world.responsibility?.releasePassportProofOwner) {
      issues.push({
        level: "error",
        code: `${metadata.key}.contractWorlds[${worldIndex}].responsibility`,
        message: "KFD-1 contract world must record source, artifact verification, and passport proof owners",
        details: { id: world.id || "" },
      });
    }
    if (world.sourceVerification?.required && world.sourceVerification?.status !== "passed") {
      issues.push({
        level: "error",
        code: `${metadata.key}.contractWorlds[${worldIndex}].sourceVerification`,
        message: "KFD-1 self contract source verification must pass before release passport finalization",
        details: { id: world.id || "", status: world.sourceVerification?.status || "" },
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
  if (!section.trustProof || typeof section.trustProof !== "object" || Array.isArray(section.trustProof)) {
    issues.push({
      level: "error",
      code: `${metadata.key}.trustProof`,
      message: "KFD-3 release evidence must include a release-passport trust proof summary",
      details: {},
    });
  } else {
    const allowedStatuses = new Set(["not-applicable", "declared", "draft", "audited", "enforced"]);
    if (!allowedStatuses.has(section.releaseStatus)) {
      issues.push({
        level: "error",
        code: `${metadata.key}.releaseStatus`,
        message: "KFD-3 release status must be not-applicable, declared, draft, audited, or enforced",
        details: { status: section.releaseStatus || "" },
      });
    }
    if (!["pass", "fail", "downgraded"].includes(section.trustProof.result)) {
      issues.push({
        level: "error",
        code: `${metadata.key}.trustProof.result`,
        message: "KFD-3 trust proof result must be pass, fail, or downgraded",
        details: { result: section.trustProof.result || "" },
      });
    }
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
    if (!entry.trustProof || typeof entry.trustProof !== "object" || Array.isArray(entry.trustProof)) {
      issues.push({
        level: "error",
        code: `${metadata.key}.collaborationInterfaces[${index}].trustProof`,
        message: "KFD-3 collaboration-interface evidence must include a trust proof",
        details: { id: entry.id || "" },
      });
    } else {
      if (entry.trustProof.result === "pass" && comparison.status !== "passed") {
        issues.push({
          level: "error",
          code: `${metadata.key}.collaborationInterfaces[${index}].trustProof.result`,
          message: "KFD-3 trust proof cannot pass when closure comparison did not pass",
          details: { id: entry.id || "", result: entry.trustProof.result, comparisonStatus: comparison.status || "" },
        });
      }
      if (!entry.trustProof.declaredCapabilityVerification) {
        issues.push({
          level: "error",
          code: `${metadata.key}.collaborationInterfaces[${index}].trustProof.declaredCapabilityVerification`,
          message: "KFD-3 trust proof must record declared capability verification",
          details: { id: entry.id || "" },
        });
      }
      if (!entry.trustProof.reverseAudit) {
        issues.push({
          level: "error",
          code: `${metadata.key}.collaborationInterfaces[${index}].trustProof.reverseAudit`,
          message: "KFD-3 trust proof must record reverse audit results",
          details: { id: entry.id || "" },
        });
      }
    }
    if (!entry.witnessEvidence?.prebuild?.canonicalSha256 || !entry.witnessEvidence?.artifact?.canonicalSha256) {
      issues.push({
        level: "error",
        code: `${metadata.key}.collaborationInterfaces[${index}].witnessEvidence`,
        message: "KFD-3 trust proof must record pre-build and artifact witness hashes",
        details: { id: entry.id || "" },
      });
    }
    if (!entry.auditBoundary || typeof entry.auditBoundary !== "object" || Array.isArray(entry.auditBoundary)) {
      issues.push({
        level: "error",
        code: `${metadata.key}.collaborationInterfaces[${index}].auditBoundary`,
        message: "KFD-3 trust proof must record the reverse audit boundary",
        details: { id: entry.id || "" },
      });
    }
    if (!Array.isArray(entry.residualRisk)) {
      issues.push({
        level: "error",
        code: `${metadata.key}.collaborationInterfaces[${index}].residualRisk`,
        message: "KFD-3 trust proof must record residual risk as an array, even when empty",
        details: { id: entry.id || "" },
      });
    }
    if (!entry.responsibility?.registryFactsOwner || !entry.responsibility?.artifactVerificationOwner || !entry.responsibility?.releasePassportProofOwner) {
      issues.push({
        level: "error",
        code: `${metadata.key}.collaborationInterfaces[${index}].responsibility`,
        message: "KFD-3 trust proof must record registry, artifact verification, and passport proof owners",
        details: { id: entry.id || "" },
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
