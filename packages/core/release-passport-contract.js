import kfdStandards from "@kungfu-tech/kfd/standards.json" with { type: "json" };
import {
  RELEASE_CHECK_REPORT_CONTRACT,
  RELEASE_PASSPORT_CONTRACT,
} from "./release-passport.js";

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
    trustedPublishing: OBJECT,
    transaction: OBJECT,
    surfaceTimestampPolicy: OBJECT,
    buildFacts: { type: "array", items: OBJECT },
    buildSummary: OBJECT,
    platformArtifactManifests: { type: "array", items: OBJECT },
    distTagPromotion: OBJECT,
    controllerReceipts: { type: "array", items: OBJECT },
    "kfd-1": OBJECT,
    "kfd-2": OBJECT,
    "kfd-3": OBJECT,
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
  "trustedPublishing",
  "transaction",
  "surfaceTimestampPolicy",
  "buildFacts",
  "buildSummary",
  "platformArtifactManifests",
  "distTagPromotion",
  "controllerReceipts",
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
