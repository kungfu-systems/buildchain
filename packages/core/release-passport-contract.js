import path from "node:path";
import kfdStandards from "@kungfu-tech/kfd/standards.json" with { type: "json" };
import {
  createKfdAdopterManifestGate,
  createKfdLegacySupportMatrixProjection,
  validateKfdLegacySupportMatrixProjection,
} from "./kfd-adopter-manifest.js";
import {
  createKfdAdopterReleaseBinding,
  installedKfdPackageArtifactRoot,
  validateKfdAdopterReleaseBinding,
} from "./artifact-verification-envelope.js";
import { normalizeAdopterDeliveryPassportBinding } from "./adopter-delivery-passport.js";

export const RELEASE_PASSPORT_CONTRACT = "kungfu-buildchain-release-passport";
export const RELEASE_CHECK_REPORT_CONTRACT = "kungfu-buildchain-release-check-report";

export const RELEASE_PASSPORT_SCHEMA_ID =
  "https://buildchain.libkungfu.dev/schemas/release-passport-v1.schema.json";
export const RELEASE_PASSPORT_CHECK_MANIFEST_CONTRACT =
  "kungfu-buildchain-release-passport-check-manifest";

const OBJECT = { type: "object" };
const STRING = { type: "string", minLength: 1 };
const OPTIONAL_STRING = { type: "string" };

export const RELEASE_PASSPORT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: RELEASE_PASSPORT_SCHEMA_ID,
  title: "Buildchain Release Passport v1",
  description:
    "Standalone structural schema for the Buildchain-owned release-passport envelope. KFD subsection semantics remain owned by their canonical KFD schemas.",
  type: "object",
  required: [
    "schemaVersion",
    "contract",
    "product",
    "release",
    "artifacts",
    "evidence",
    "recovery",
  ],
  properties: {
    schemaVersion: { const: 1 },
    contract: { const: RELEASE_PASSPORT_CONTRACT },
    generatedAt: { type: "string", format: "date-time" },
    product: {
      type: "object",
      required: ["name", "repository", "mechanism"],
      properties: {
        name: STRING,
        repository: STRING,
        mechanism: STRING,
      },
      additionalProperties: true,
    },
    release: {
      type: "object",
      required: ["tag"],
      properties: {
        tag: STRING,
        sourceSha: OPTIONAL_STRING,
        releaseSha: OPTIONAL_STRING,
        releaseMaterialSha: OPTIONAL_STRING,
        targetRef: OPTIONAL_STRING,
        channel: OPTIONAL_STRING,
        line: OPTIONAL_STRING,
        package: OBJECT,
      },
      additionalProperties: true,
    },
    artifacts: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name"],
        properties: { name: STRING },
        additionalProperties: true,
      },
    },
    evidence: {
      type: "object",
      required: ["artifactEvidence", "impact", "agentIndex"],
      properties: {
        artifactEvidence: STRING,
        impact: STRING,
        agentIndex: STRING,
        publishEvidence: OPTIONAL_STRING,
        transactionState: OPTIONAL_STRING,
      },
      additionalProperties: true,
    },
    recovery: OBJECT,
    workflow: OBJECT,
    runnerPolicy: OBJECT,
    versionImpact: OBJECT,
    surfaceImpacts: { type: "array", items: OBJECT },
    packageSet: OBJECT,
    anchorManifest: OBJECT,
    versionMaterial: OBJECT,
    trustedPublishing: OBJECT,
    transaction: OBJECT,
    surfaceTimestampPolicy: OBJECT,
    buildFacts: { type: "array", items: OBJECT },
    buildSummary: OBJECT,
    platformArtifactManifests: { type: "array", items: OBJECT },
    distTagPromotion: OBJECT,
    controllerReceipts: { type: "array", items: OBJECT },
    githubArtifactAttestations: { type: "array", items: OBJECT },
    "kfd-1": OBJECT,
    "kfd-2": OBJECT,
    "kfd-3": OBJECT,
    adopterDelivery: OBJECT,
    kfdAdopter: OBJECT,
    kfdSupport: OBJECT,
  },
  additionalProperties: true,
};

const BUILDCHAIN_AGGREGATION_FIELDS = [
  "product",
  "release",
  "workflow",
  "runnerPolicy",
  "versionImpact",
  "surfaceImpacts",
  "packageSet",
  "anchorManifest",
  "versionMaterial",
  "trustedPublishing",
  "transaction",
  "surfaceTimestampPolicy",
  "buildFacts",
  "buildSummary",
  "platformArtifactManifests",
  "distTagPromotion",
  "controllerReceipts",
  "adopterDelivery",
  "kfdAdopter",
  "kfdSupport",
  "githubArtifactAttestations",
  "artifacts",
  "evidence",
  "recovery",
];

function kfdSectionAuthority(id, standards = kfdStandards) {
  const standard = standards?.standards?.[id] || {};
  return {
    section: id,
    owner: "KFD",
    package: standards?.source?.package || "@kungfu-tech/kfd",
    metadataSchema: standards?.metadataSchema || {},
    schemaIds: standard.schemaIds || {},
    schemaPaths: standard.schemaPaths || {},
    compatibility: standard.compatibility || {},
    rule: `Buildchain aggregates and checks ${id} evidence but does not redefine its schema semantics.`,
  };
}

export function createReleasePassportCheckManifest({ standards = kfdStandards } = {}) {
  return {
    schemaVersion: 1,
    contract: RELEASE_PASSPORT_CHECK_MANIFEST_CONTRACT,
    passport: {
      contract: RELEASE_PASSPORT_CONTRACT,
      schemaVersion: 1,
      schema: {
        id: RELEASE_PASSPORT_SCHEMA_ID,
        path: "schemas/release-passport-v1.schema.json",
        npmExport: "@kungfu-tech/buildchain/site/schemas/release-passport-v1.schema.json",
      },
      checker: {
        contract: RELEASE_CHECK_REPORT_CONTRACT,
        command: "buildchain verify release-passport <buildchain.release.json>",
        nodeApi: "@kungfu-tech/buildchain/release-passport#verifyReleasePassport",
        result: "check-report.json",
      },
      kfdSupportProjection: {
        authorityContract: "kfd.adopter-conformance-manifest/v1",
        gateContract: "kungfu-buildchain-kfd-adopter-manifest-gate",
        bindingContract: "kungfu-buildchain-kfd-adopter-release-binding",
        evidence: "kfd-support.json",
        rule:
          "The standard adopter manifest is the sole declaration authority; the legacy support matrix is an exact derived projection only.",
      },
    },
    ownership: {
      envelopeOwner: "Buildchain",
      aggregationFields: BUILDCHAIN_AGGREGATION_FIELDS,
      kfdSections: ["kfd-1", "kfd-2", "kfd-3"].map((id) =>
        kfdSectionAuthority(id, standards),
      ),
    },
    localClosure: {
      entrypoint: "buildchain.release.json",
      resolutionBase: "directory containing the passport",
      requiredSiblings: [
        "product.mechanism",
        "evidence.artifactEvidence",
        "evidence.impact",
        "evidence.agentIndex",
      ],
      conditionalSiblings: [
        {
          when: "evidence.publishEvidence is present or packageSet is present",
          pointer: "evidence.publishEvidence",
        },
        {
          when: "evidence.transactionState is present",
          pointer: "evidence.transactionState",
        },
        {
          when: "kfdSupport is present",
          pointer: "evidence.kfdSupport",
        },
        {
          when: "kfdAdopter is present",
          pointer: "evidence.kfdAdopterManifest",
        },
        {
          when: "kfdAdopter is present",
          pointer: "evidence.kfdAdopterGate",
        },
      ],
      rule:
        "The normative checker resolves every declared sibling relative to the passport and fails closed on missing required evidence, digest drift, or semantic mismatch.",
    },
    compatibility: {
      envelope:
        "Compatible optional fields may be added while schemaVersion remains 1; removing or changing required-field semantics requires a new schema id or contract version.",
      siblings:
        "New optional siblings may be added in v1; making a sibling required requires a new schema id or contract version.",
      kfdSections:
        "Each KFD subsection follows the compatibility metadata published by @kungfu-tech/kfd; Buildchain must not silently reinterpret a KFD schema version.",
      unknownFields: "Independent readers must preserve or ignore unknown additive fields.",
    },
  };
}

function matchesType(value, type) {
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function validateSchemaNode(schema, value, pointer, issues) {
  if (schema.type && !matchesType(value, schema.type)) {
    issues.push({ pointer, code: "type", message: `${pointer} must be ${schema.type}` });
    return;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    issues.push({ pointer, code: "const", message: `${pointer} must equal ${JSON.stringify(schema.const)}` });
  }
  if (schema.minLength && typeof value === "string" && value.length < schema.minLength) {
    issues.push({ pointer, code: "minLength", message: `${pointer} must not be empty` });
  }
  if (schema.minItems && Array.isArray(value) && value.length < schema.minItems) {
    issues.push({ pointer, code: "minItems", message: `${pointer} must contain at least ${schema.minItems} item(s)` });
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => validateSchemaNode(schema.items, entry, `${pointer}/${index}`, issues));
  }
  if (matchesType(value, "object")) {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) {
        issues.push({ pointer: `${pointer}/${key}`, code: "required", message: `${pointer}/${key} is required` });
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) {
        validateSchemaNode(childSchema, value[key], `${pointer}/${key}`, issues);
      }
    }
  }
}

export function validateReleasePassportSchema(passport) {
  const issues = [];
  validateSchemaNode(RELEASE_PASSPORT_SCHEMA, passport, "#", issues);
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-passport-schema-validation",
    schemaId: RELEASE_PASSPORT_SCHEMA_ID,
    ok: issues.length === 0,
    issues,
  };
}

function passportStableJson(value) {
  if (Array.isArray(value)) return `[${value.map(passportStableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${passportStableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function passportOptional(value) {
  return value === undefined || value === null ? "" : String(value);
}

export function defaultReleaseProductMechanism({ repository = "", productName = "Buildchain" } = {}) {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-product-mechanism",
    product: { name: productName, repository, northStar: "GitHub-native release passport protocol for binary and multi-artifact products." },
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

export function defaultReleaseImpact({ tag = "", line = "", decision = "unknown" } = {}) {
  const normalized = String(decision).toLowerCase();
  const final = ["unknown", "patch", "minor", "major"].includes(normalized) ? normalized : String(decision);
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-impact",
    release: { tag, line },
    versionImpact: { final, source: "default", rationale: "No surface impact classification was supplied." },
    surfaceImpacts: [],
    classification: final,
    breaking: final === "major",
    security: false,
    migrationRequired: final === "major",
    summary: "No release impact summary was supplied.",
    recovery: { rollback: "Use the previous exact release tag or previous floating channel ref.", block: "Fail closed if release passport verification fails." },
  };
}

export function defaultReleaseAgentIndex({ tag = "", passportPath = "buildchain.release.json" } = {}) {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-agent-index",
    release: { tag },
    entrypoints: [
      { id: "release-passport", kind: "json", path: passportPath, description: "Read this first to verify release completeness, artifacts, impact, and recovery pointers." },
      { id: "llms", kind: "text", path: "llms.txt", description: "Short agent-readable release instructions." },
    ],
  };
}

export function defaultReleaseLlmsText({ tag = "", passportPath = "buildchain.release.json" } = {}) {
  return [
    "# Buildchain Release Passport",
    "",
    `Release: ${tag || "unknown"}`,
    "",
    `Start with ${passportPath}. Verify artifact-evidence.json before installing binaries.`,
    "If verification fails, do not install or promote this release.",
  ].join("\n");
}

export function buildReleaseArtifactEvidence({ normalizedAssets = [], repository = "", tag = "", sourceSha = "", workflow = {}, adopterDelivery, kfdAdopter } = {}) {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact-evidence",
    repository: passportOptional(repository),
    release: { tag: passportOptional(tag), sourceSha: passportOptional(sourceSha) },
    generatedAt: new Date().toISOString(),
    runner: {
      kind: passportOptional(workflow.runnerKind || workflow.runner?.kind || ""),
      os: passportOptional(workflow.runnerOs || workflow.runner?.os || ""),
      arch: passportOptional(workflow.runnerArch || workflow.runner?.arch || ""),
      labels: Array.isArray(workflow.runnerLabels) ? workflow.runnerLabels : [],
      image: passportOptional(workflow.runnerImage || workflow.runner?.image || ""),
    },
    workflow: {
      name: passportOptional(workflow.name),
      runId: passportOptional(workflow.runId),
      runAttempt: passportOptional(workflow.runAttempt),
      url: passportOptional(workflow.url),
    },
    artifacts: normalizedAssets.map((asset) => ({
      name: asset.name, kind: asset.kind, platform: asset.platform, size: asset.size,
      sha256: asset.sha256, url: asset.url, githubAssetId: asset.githubAssetId,
      attestation: passportOptional(asset.attestation || ""),
    })),
    ...(adopterDelivery ? { adopterDelivery: normalizeAdopterDeliveryPassportBinding(adopterDelivery) } : {}),
    ...(kfdAdopter ? { kfdAdopter: structuredClone(kfdAdopter) } : {}),
  };
}

export function prepareReleasePassportKfdSections({ kfd1, kfd2Claims, kfd3, kfdAdopter, kfdSupport, kfd1DefaultKey, createKfd2, evidencePaths = {} } = {}) {
  const one = kfd1?.passportSection ? kfd1 : undefined;
  const three = kfd3?.passportSection ? kfd3 : undefined;
  const adopter = kfdAdopter ? structuredClone(kfdAdopter) : undefined;
  const support = kfdSupport ? structuredClone(kfdSupport) : undefined;
  const two = createKfd2({ explicitClaims: kfd2Claims, kfd1Section: one?.passportSection, kfd3Section: three?.passportSection });
  return {
    sectionEntries: [
      [one?.key || kfd1DefaultKey, one?.passportSection], ["kfd-2", two],
      [three?.key || "kfd-3", three?.passportSection], ["kfdAdopter", adopter], ["kfdSupport", support],
    ],
    evidence: {
      kfd1: one ? `${one.key || kfd1DefaultKey}` : "", kfd2: two ? "kfd-2" : "", kfd3: three ? `${three.key || "kfd-3"}` : "",
      kfdAdopterManifest: adopter ? evidencePaths.manifest || "kfd-adopter-manifest.json" : "",
      kfdAdopterGate: adopter ? evidencePaths.gate || "kfd-adopter-manifest-gate.json" : "",
      kfdSupport: support ? evidencePaths.support || "kfd-support.json" : "",
    },
  };
}

export function collectKfdAdopterReleaseEvidence({ manifest, gateResults = [], comparisonMatrix, expectedAdopterId = "kungfu-systems/buildchain", expectedSourceRepository = "", sourceSha = "", checkedAt } = {}) {
  if (!manifest) {
    if (comparisonMatrix || gateResults.length > 0) {
      throw new Error("KFD support and product-gate inputs require --kfd-adopter-manifest-json; --kfd-support-matrix-json is comparison-only");
    }
    return {};
  }
  let authorityPath = "kfd-adopter-manifest.json";
  let producerCheckedAt = checkedAt;
  if (comparisonMatrix) {
    authorityPath = String(comparisonMatrix?.authority?.path || "").trim().replaceAll("\\", "/");
    if (!authorityPath || path.isAbsolute(authorityPath) || authorityPath.split("/").includes("..")) {
      throw new Error("legacy KFD support matrix must bind a safe repository-relative adopter manifest authority path");
    }
    const gateCheckedAts = [...new Set(gateResults.map((gate) => String(gate?.checkedAt || "").trim()))];
    if (gateCheckedAts.length !== 1 || !Number.isFinite(Date.parse(gateCheckedAts[0]))) {
      throw new Error("KFD product gates must bind one exact producer checkedAt cut for legacy projection comparison");
    }
    producerCheckedAt = gateCheckedAts[0];
  }
  const manifestGate = createKfdAdopterManifestGate({
    manifest, packageArtifactRoot: installedKfdPackageArtifactRoot(), gateResults,
    authorityPath, expectedAdopterId, expectedSourceRepository, expectedSourceSha: sourceSha, checkedAt: producerCheckedAt,
  });
  const legacyProjection = createKfdLegacySupportMatrixProjection({ manifest, manifestGate });
  if (comparisonMatrix) {
    const comparison = validateKfdLegacySupportMatrixProjection(comparisonMatrix, { manifest, manifestGate });
    if (!comparison.valid) {
      throw new Error(`legacy KFD support matrix drifted from the standard adopter manifest: ${JSON.stringify(comparison.issues)}`);
    }
  }
  return {
    manifest, manifestGate, legacyProjection,
    binding: createKfdAdopterReleaseBinding({ manifest, manifestGate, legacyProjection, expectedAdopterId, expectedSourceRepository, expectedSourceSha: sourceSha }),
  };
}

export function validateKfdAdopterReleaseEvidence({ binding, artifactBinding, manifest, manifestGate, legacyProjection, passportLegacyProjection, expectedAdopterId = "kungfu-systems/buildchain", expectedSourceRepository = "", expectedSourceSha = "" } = {}) {
  if (!binding) {
    return passportLegacyProjection
      ? [{ code: "kfdSupport.authority", message: "legacy KFD support projection requires the standard adopter manifest binding" }]
      : [];
  }
  const issues = validateKfdAdopterReleaseBinding(binding, {
    manifest, manifestGate, legacyProjection, expectedAdopterId, expectedSourceRepository, expectedSourceSha,
  }).issues.map((entry) => ({ code: `kfdAdopter.${entry.path || entry.code}`, message: entry.message, details: entry }));
  if (!artifactBinding || passportStableJson(artifactBinding) !== passportStableJson(binding)) {
    issues.push({ code: "kfdAdopter.artifactEvidence", message: "release passport and artifact evidence must bind the same exact KFD adopter closure" });
  }
  if (!passportLegacyProjection || !legacyProjection
    || passportStableJson(legacyProjection) !== passportStableJson(passportLegacyProjection)) {
    issues.push({ code: "kfdAdopter.legacyProjection", message: "legacy support projection must exactly match the manifest-derived passport sibling" });
  }
  return issues;
}

async function explicitOrSibling({ location, basePath, sibling, readJson, resolveSibling, fallback }) {
  if (location) return readJson(location);
  return await resolveSibling(basePath, sibling) || fallback;
}

export async function resolveReleasePassportVerificationInputs({ passportLocation, locations = {}, readJson, resolveSibling } = {}) {
  const passport = await readJson(passportLocation);
  const basePath = /^https?:\/\//.test(passportLocation) ? passportLocation : path.resolve(passportLocation);
  const resolve = (location, sibling, fallback) => explicitOrSibling({ location, basePath, sibling, readJson, resolveSibling, fallback });
  const releaseEvidenceDocuments = [];
  for (const reference of Array.isArray(passport.releaseEvidence) ? passport.releaseEvidence : []) {
    const id = String(reference?.id || "");
    const safePath = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && reference?.path === `release-evidence-${id}.json`;
    releaseEvidenceDocuments.push({ reference, document: safePath ? await resolveSibling(basePath, reference.path) : undefined });
  }
  return {
    passport,
    artifactEvidence: await resolve(locations.artifactEvidence, passport.evidence?.artifactEvidence, {}),
    publishEvidence: await resolve(locations.publishEvidence, passport.evidence?.publishEvidence, {}),
    impact: await resolve(locations.impact, passport.evidence?.impact, {}),
    agentIndex: await resolve(locations.agentIndex, passport.evidence?.agentIndex, {}),
    productMechanism: await resolve(locations.productMechanism, passport.product?.mechanism, {}),
    kfdAgentHubEvidence: await resolve(locations.kfdAgentHubEvidence, passport.evidence?.kfdAgentHub),
    kfdAdopterManifest: await resolve(locations.kfdAdopterManifest, passport.evidence?.kfdAdopterManifest),
    kfdAdopterManifestGate: await resolve(locations.kfdAdopterManifestGate, passport.evidence?.kfdAdopterGate),
    kfdSupportEvidence: await resolve(locations.kfdSupportEvidence, passport.evidence?.kfdSupport),
    releaseEvidenceDocuments,
  };
}
