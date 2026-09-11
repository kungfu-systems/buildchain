import crypto from "node:crypto";

export const KUNGFU_FACT_ROOT_PROTOCOL = "kungfu.fact-root.canonical/v2";
export const KUNGFU_TEMPORAL_BUNDLE_SCHEMA = "kungfu.fact.temporal-bundle/v1";
export const KUNGFU_TEMPORAL_PATH_QUERY_SCHEMA =
  "kungfu.fact.temporal-path-query/v1";
export const KUNGFU_TEMPORAL_PATH_RECEIPT_SCHEMA =
  "kungfu.fact.temporal-path-receipt/v1";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_PATH_DEPTH = 32;
const SCHEMA_FIELDS = {
  "kungfu.fact.temporal-predicate/v1": [
    "schema",
    "predicateId",
    "operations",
    "direction",
    "pathPolicy",
    "cyclePolicy",
    "authorityRoot",
  ],
  "kungfu.fact.temporal-relation/v1": [
    "schema",
    "relationId",
    "predicateRoot",
    "sourceRoot",
    "targetRoot",
    "validFromCutRoot",
    "scopeRoot",
    "authorityRoot",
    "admissionRoots",
  ],
  "kungfu.fact.temporal-supersession/v1": [
    "schema",
    "priorRelationRoot",
    "successorRelationRoot",
    "effectiveCutRoot",
    "reasonRoot",
    "authorityRoot",
    "admissionRoots",
  ],
  "kungfu.fact.temporal-revocation/v1": [
    "schema",
    "relationRoot",
    "effectiveCutRoot",
    "reasonRoot",
    "authorityRoot",
    "admissionRoots",
  ],
  "kungfu.fact.temporal-authority-proof/v1": [
    "schema",
    "proofId",
    "subjectAuthorityRoot",
    "governingAuthorityRoot",
    "operations",
    "validFromCutRoot",
    "revokedAtCutRoot",
    "admissionRoots",
  ],
  [KUNGFU_TEMPORAL_PATH_QUERY_SCHEMA]: [
    "schema",
    "queryId",
    "operation",
    "predicateRoot",
    "sourceRoot",
    "targetRoot",
    "cutRoot",
    "relationPathRoots",
    "requiredAuthorityRoot",
    "maxDepth",
  ],
  [KUNGFU_TEMPORAL_PATH_RECEIPT_SCHEMA]: [
    "schema",
    "queryRoot",
    "status",
    "failureCode",
    "cutRoot",
    "relationPathRoots",
    "authorityProofRoots",
    "omissionRoots",
  ],
};
const SET_FIELDS = new Set([
  "operations",
  "admissionRoots",
  "authorityProofRoots",
  "omissionRoots",
]);
const ARRAY_FIELDS = new Set(["relationPathRoots"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function textBytes(value) {
  return Buffer.from(value, "utf8");
}

function encodeTyped(value) {
  switch (value?.type) {
    case "null":
      return Buffer.from([0]);
    case "u64":
      return Buffer.concat([Buffer.from([0x10]), u64(value.value)]);
    case "text": {
      const bytes = textBytes(value.value);
      return Buffer.concat([Buffer.from([0x20]), u64(bytes.length), bytes]);
    }
    case "array":
    case "set": {
      const items = (value.items || []).map(encodeTyped);
      if (value.type === "set") items.sort(Buffer.compare);
      if (
        items.some(
          (entry, index) => index > 0 && entry.equals(items[index - 1]),
        )
      ) {
        fail("canonical-duplicate-item", "set contains equal canonical items");
      }
      return Buffer.concat([
        Buffer.from([value.type === "array" ? 0x30 : 0x31]),
        u64(items.length),
        ...items,
      ]);
    }
    case "record": {
      const allowed = SCHEMA_FIELDS[value.schema];
      if (!allowed)
        fail(
          "canonical-unknown-schema",
          `unregistered temporal schema: ${value.schema || "<empty>"}`,
        );
      const fields = [...(value.fields || [])].sort(
        (left, right) => Number(left.id) - Number(right.id),
      );
      if (
        fields.length !== allowed.length ||
        fields.some((field, index) => Number(field.id) !== index + 1)
      ) {
        fail(
          "canonical-missing-field",
          "temporal record does not contain its exact closed field set",
        );
      }
      const schema = encodeTyped({ type: "text", value: value.schema });
      return Buffer.concat([
        Buffer.from([0x40]),
        schema,
        u64(fields.length),
        ...fields.flatMap((field) => [u64(field.id), encodeTyped(field.value)]),
      ]);
    }
    default:
      fail(
        "canonical-unsupported-type",
        `unsupported canonical type: ${value?.type || "<empty>"}`,
      );
  }
}

function root(value, field) {
  if (typeof value !== "string" || !ROOT_PATTERN.test(value))
    fail("orphan-root", `${field} must be a lowercase SHA-256 root`);
  return value;
}

function typedField(field, value) {
  if (SET_FIELDS.has(field)) {
    if (
      !Array.isArray(value) ||
      value.some((entry) => typeof entry !== "string")
    )
      fail("invalid-record", `${field} must be an array of strings`);
    return {
      type: "set",
      items: value.map((entry) => ({
        type: "text",
        value: field.endsWith("Roots") ? root(entry, field) : entry,
      })),
    };
  }
  if (ARRAY_FIELDS.has(field)) {
    if (!Array.isArray(value))
      fail("invalid-record", `${field} must be an array`);
    return {
      type: "array",
      items: value.map((entry) => ({
        type: "text",
        value: root(entry, field),
      })),
    };
  }
  if (field === "revokedAtCutRoot" && value === null) return { type: "null" };
  if (field === "maxDepth") {
    if (!Number.isSafeInteger(value) || value < 0)
      fail("invalid-record", "maxDepth must be an unsigned integer");
    return { type: "u64", value: String(value) };
  }
  if (field.endsWith("Root"))
    return { type: "text", value: root(value, field) };
  if (typeof value !== "string" || (!value && field !== "failureCode"))
    fail("invalid-record", `${field} must be a non-empty string`);
  return { type: "text", value };
}

export function kungfuTemporalRecordRoot(record) {
  const fields = SCHEMA_FIELDS[record?.schema];
  if (
    !fields ||
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !(field in record))
  ) {
    fail(
      "invalid-record",
      "temporal record fields do not match its closed schema",
    );
  }
  const descriptor = {
    type: "record",
    schema: record.schema,
    fields: fields.map((field, index) => ({
      id: String(index + 1),
      value: typedField(field, record[field]),
    })),
  };
  return `sha256:${crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from("KFR2"), encodeTyped(descriptor)]))
    .digest("hex")}`;
}

export function createKungfuTemporalEntry(record) {
  return {
    root: kungfuTemporalRecordRoot(record),
    record: structuredClone(record),
  };
}

function indexEntries(entries, family) {
  if (!Array.isArray(entries))
    fail("invalid-bundle", `${family} must be an array`);
  const indexed = new Map();
  for (const entry of entries) {
    if (!entry || Object.keys(entry).sort().join(",") !== "record,root")
      fail("invalid-bundle", `${family} entries require root and record`);
    if (entry.root !== kungfuTemporalRecordRoot(entry.record))
      fail("root-mismatch", `${family} record root does not match its bytes`);
    if (indexed.has(entry.root))
      fail("ambiguous-root", `${family} contains a duplicate root`);
    indexed.set(entry.root, entry.record);
  }
  return indexed;
}

function indexCuts(entries) {
  const cuts = new Map();
  for (const cut of entries || []) {
    if (
      !cut ||
      Object.keys(cut).sort().join(",") !==
        "activeRelationRoots,declarationRoots,parentCutRoots,root"
    )
      fail("invalid-bundle", "Cut projection has unexpected fields");
    root(cut.root, "cut.root");
    if (cuts.has(cut.root))
      fail("ambiguous-root", "Cut projection contains a duplicate root");
    for (const field of [
      "parentCutRoots",
      "activeRelationRoots",
      "declarationRoots",
    ]) {
      if (
        !Array.isArray(cut[field]) ||
        new Set(cut[field]).size !== cut[field].length
      )
        fail("invalid-bundle", `${field} must be a duplicate-free array`);
      cut[field].forEach((entry) => root(entry, field));
    }
    cuts.set(cut.root, cut);
  }
  return cuts;
}

function ancestorResolver(cuts) {
  const ancestor = (earlier, later, visiting = new Set()) => {
    if (earlier === later) return true;
    if (visiting.has(later)) fail("forbidden-cycle", "Cut lineage is cyclic");
    const cut = cuts.get(later);
    if (!cut) fail("orphan-root", "Cut lineage references an unknown root");
    visiting.add(later);
    const found = cut.parentCutRoots.some((parent) =>
      ancestor(earlier, parent, visiting),
    );
    visiting.delete(later);
    return found;
  };
  return ancestor;
}

function assertCutAcyclic(cuts) {
  const visited = new Set();
  const visit = (cutRoot, visiting = new Set()) => {
    if (visiting.has(cutRoot)) fail("forbidden-cycle", "Cut lineage is cyclic");
    if (visited.has(cutRoot)) return;
    const cut = cuts.get(cutRoot);
    if (!cut) fail("orphan-root", "Cut parent is absent from bundle");
    visiting.add(cutRoot);
    cut.parentCutRoots.forEach((parent) => visit(parent, visiting));
    visiting.delete(cutRoot);
    visited.add(cutRoot);
  };
  [...cuts.keys()].forEach((cutRoot) => visit(cutRoot));
}

function validateCutReferences(bundle) {
  assertCutAcyclic(bundle.cuts);
  for (const cut of bundle.cuts.values()) {
    if (cut.activeRelationRoots.some((entry) => !bundle.relations.has(entry))) {
      fail("orphan-root", "Cut contains an unknown relation");
    }
    if (cut.declarationRoots.some((entry) => !bundle.predicates.has(entry))) {
      fail("orphan-root", "Cut contains an unknown predicate");
    }
  }
}

function validateDeclarations(bundle) {
  for (const relation of bundle.relations.values()) {
    if (!bundle.predicates.has(relation.predicateRoot))
      fail("unknown-predicate", "relation references an unknown predicate");
    if (!bundle.cuts.has(relation.validFromCutRoot))
      fail("orphan-root", "relation references an unknown Cut");
  }
  for (const predicate of bundle.predicates.values()) {
    if (
      predicate.direction !== "source-to-target" ||
      !["single-edge", "explicit-bounded"].includes(predicate.pathPolicy) ||
      predicate.cyclePolicy !== "forbid" ||
      predicate.operations.length === 0
    ) {
      fail(
        "invalid-record",
        "predicate direction, path, cycle, or operation policy is invalid",
      );
    }
  }
}

function validateSupersessions(bundle) {
  const supersessionEdges = new Map();
  for (const record of bundle.supersessions.values()) {
    if (
      !bundle.relations.has(record.priorRelationRoot) ||
      !bundle.relations.has(record.successorRelationRoot) ||
      !bundle.cuts.has(record.effectiveCutRoot)
    )
      fail("orphan-root", "supersession references an unknown relation or Cut");
    supersessionEdges.set(record.priorRelationRoot, [
      ...(supersessionEdges.get(record.priorRelationRoot) || []),
      record.successorRelationRoot,
    ]);
  }
  const visit = (current, visiting = new Set(), visited = new Set()) => {
    if (visiting.has(current))
      fail("forbidden-cycle", "supersession records form a cycle");
    if (visited.has(current)) return;
    visiting.add(current);
    (supersessionEdges.get(current) || []).forEach((next) =>
      visit(next, visiting, visited),
    );
    visiting.delete(current);
    visited.add(current);
  };
  [...supersessionEdges.keys()].forEach((entry) => visit(entry));
}

function validateRevocations(bundle) {
  for (const record of bundle.revocations.values()) {
    if (
      !bundle.relations.has(record.relationRoot) ||
      !bundle.cuts.has(record.effectiveCutRoot)
    )
      fail("orphan-root", "revocation references an unknown relation or Cut");
  }
}

function loadBundle(document) {
  const fields = [
    "schema",
    "cuts",
    "predicates",
    "relations",
    "supersessions",
    "revocations",
    "authorityProofs",
    "provenanceObjects",
  ];
  if (
    !document ||
    Object.keys(document).sort().join(",") !== [...fields].sort().join(",") ||
    document.schema !== KUNGFU_TEMPORAL_BUNDLE_SCHEMA
  ) {
    fail(
      "invalid-bundle",
      "bundle fields do not match the closed temporal schema",
    );
  }
  const cuts = indexCuts(document.cuts);
  const bundle = {
    cuts,
    predicates: indexEntries(document.predicates, "predicates"),
    relations: indexEntries(document.relations, "relations"),
    supersessions: indexEntries(document.supersessions, "supersessions"),
    revocations: indexEntries(document.revocations, "revocations"),
    authorityProofs: indexEntries(document.authorityProofs, "authorityProofs"),
  };
  validateCutReferences(bundle);
  validateDeclarations(bundle);
  validateSupersessions(bundle);
  validateRevocations(bundle);
  const ancestor = ancestorResolver(cuts);
  return { ...bundle, ancestor };
}

function receipt(query, status, failureCode, authorityProofRoots = []) {
  return createKungfuTemporalEntry({
    schema: KUNGFU_TEMPORAL_PATH_RECEIPT_SCHEMA,
    queryRoot: kungfuTemporalRecordRoot(query),
    status,
    failureCode,
    cutRoot: query.cutRoot,
    relationPathRoots: [...query.relationPathRoots],
    authorityProofRoots: [...new Set(authorityProofRoots)].sort(),
    omissionRoots: [],
  });
}

function queryContext(bundle, query) {
  const cut = bundle.cuts.get(query.cutRoot);
  if (!cut) fail("orphan-root", "query Cut is absent from bundle");
  const predicate = bundle.predicates.get(query.predicateRoot);
  if (!predicate || !cut.declarationRoots.includes(query.predicateRoot)) {
    fail("unknown-predicate", "predicate is not declared at this Cut");
  }
  if (predicate.authorityRoot !== query.requiredAuthorityRoot) {
    fail("authority-missing", "query authority does not own predicate");
  }
  if (!predicate.operations.includes(query.operation)) {
    fail("unscoped-compatibility", "operation is outside predicate scope");
  }
  const path = query.relationPathRoots;
  if (
    !Number.isSafeInteger(query.maxDepth) ||
    query.maxDepth < 1 ||
    query.maxDepth > MAX_PATH_DEPTH ||
    path.length > query.maxDepth
  ) {
    fail("path-bound-exceeded", "path exceeds verifier bound");
  }
  if (path.length === 0)
    fail("path-missing", "the verifier does not search for a path");
  if (new Set(path).size !== path.length)
    fail("forbidden-cycle", "a relation repeats in the explicit path");
  if (path.length > 1 && predicate.pathPolicy !== "explicit-bounded") {
    fail("implicit-transitive-acceptance", "predicate forbids composed paths");
  }
  return { cut, path };
}

function assertRelationCurrent(bundle, relationRoot, cutRoot, cut) {
  const relation = bundle.relations.get(relationRoot);
  if (!relation) fail("orphan-root", "path contains an unknown relation");
  if (!bundle.ancestor(relation.validFromCutRoot, cutRoot))
    fail("relation-not-yet-valid", "relation is not valid at Cut");
  const superseded = [...bundle.supersessions.values()].some(
    (record) =>
      record.priorRelationRoot === relationRoot &&
      bundle.ancestor(record.effectiveCutRoot, cutRoot),
  );
  if (superseded) fail("relation-superseded", "relation was superseded at Cut");
  const revoked = [...bundle.revocations.values()].some(
    (record) =>
      record.relationRoot === relationRoot &&
      bundle.ancestor(record.effectiveCutRoot, cutRoot),
  );
  if (revoked) fail("relation-revoked", "relation was revoked at Cut");
  if (!cut.activeRelationRoots.includes(relationRoot))
    fail("relation-inactive-at-cut", "relation is inactive at Cut");
  return relation;
}

function authorityRoots(bundle, relation, query) {
  if (relation.authorityRoot === query.requiredAuthorityRoot) return [];
  const matches = [...bundle.authorityProofs.entries()].filter(
    ([, proof]) =>
      proof.subjectAuthorityRoot === relation.authorityRoot &&
      proof.governingAuthorityRoot === query.requiredAuthorityRoot &&
      proof.operations.includes(query.operation) &&
      bundle.ancestor(proof.validFromCutRoot, query.cutRoot) &&
      (proof.revokedAtCutRoot === null ||
        !bundle.ancestor(proof.revokedAtCutRoot, query.cutRoot)),
  );
  if (matches.length === 0)
    fail("authority-missing", "no exact authority proof applies at Cut");
  if (matches.length > 1)
    fail("ambiguous-authority", "more than one authority proof applies");
  return [matches[0][0]];
}

function walkPath(bundle, query, context, authorityProofRoots) {
  let cursor = query.sourceRoot;
  const endpoints = new Set([cursor]);
  for (const relationRoot of context.path) {
    const relation = assertRelationCurrent(
      bundle,
      relationRoot,
      query.cutRoot,
      context.cut,
    );
    if (relation.predicateRoot !== query.predicateRoot)
      fail("predicate-mismatch", "path crosses predicates");
    if (relation.sourceRoot !== cursor)
      fail("direction-mismatch", "relation direction does not match path");
    cursor = relation.targetRoot;
    if (endpoints.has(cursor))
      fail("forbidden-cycle", "explicit path repeats an endpoint");
    endpoints.add(cursor);
    authorityProofRoots.push(...authorityRoots(bundle, relation, query));
  }
  if (cursor !== query.targetRoot)
    fail("direction-mismatch", "explicit path does not reach target");
  return authorityProofRoots;
}

export function verifyKungfuTemporalPath(document, query) {
  if (query?.schema !== KUNGFU_TEMPORAL_PATH_QUERY_SCHEMA)
    fail("unknown-schema", "query schema is not supported");
  kungfuTemporalRecordRoot(query);
  const authorityProofRoots = [];
  try {
    const bundle = loadBundle(document);
    const context = queryContext(bundle, query);
    walkPath(bundle, query, context, authorityProofRoots);
    return receipt(query, "accepted", "", authorityProofRoots);
  } catch (error) {
    if (!error?.code) throw error;
    return receipt(query, "rejected", error.code, authorityProofRoots);
  }
}
