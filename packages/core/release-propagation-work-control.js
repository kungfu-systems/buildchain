import {
  assertPlainObject,
  assertString,
  optionalString,
  sha256Json,
} from "./release-propagation-common.js";
import { EXECUTION_ACTIONS } from "./release-propagation-work-constants.js";

const WORK_REF_SCHEMA = "kungfu.assignment-graph.work-ref/v1";
const FAMILY_STATE_V2_SCHEMA = "kungfu.work-control.initiative-family-state/v2";
const TYPED_REFERENCE_FIELDS = new Set([
  "kind",
  "identity",
  "root",
  "factWorld",
  "cutRoot",
  "schema",
  "status",
]);

export function contentRoot(value) {
  return `sha256:${sha256Json(value)}`;
}

export function assertExactFields(value, fields, label) {
  const object = assertPlainObject(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has an invalid field set`);
  }
  return object;
}

export function assertContentRoot(value, label, { optional = false } = {}) {
  const root = optionalString(value);
  if (optional && !root) {
    return "";
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(root)) {
    throw new Error(`${label} must be a sha256 content root`);
  }
  return root;
}

export function assertCommitSha(value, label) {
  const sha = assertString(value, label).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${label} must be an exact 40-character Git SHA`);
  }
  return sha;
}

export function assertIsoTimestamp(value, label) {
  const timestamp = assertString(value, label);
  if (Number.isNaN(Date.parse(timestamp)) || !/(?:Z|[+-]\d\d:\d\d)$/.test(timestamp)) {
    throw new Error(`${label} must be an ISO-8601 timestamp with timezone`);
  }
  return timestamp;
}

export function normalizeWorkRef(value, label) {
  const ref = assertExactFields(value, [
    "schema",
    "workspace_identity_root",
    "object_kind",
    "subject",
    "version_root",
    "cut_root",
  ], label);
  if (ref.schema !== WORK_REF_SCHEMA) {
    throw new Error(`${label}.schema must be ${WORK_REF_SCHEMA}`);
  }
  if (!new Set(["initiative", "assignment"]).has(ref.object_kind)) {
    throw new Error(`${label}.object_kind must be initiative or assignment`);
  }
  const subject = assertString(ref.subject, `${label}.subject`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(subject)) {
    throw new Error(`${label}.subject is not canonical`);
  }
  return {
    schema: WORK_REF_SCHEMA,
    workspace_identity_root: assertContentRoot(ref.workspace_identity_root, `${label}.workspace_identity_root`),
    object_kind: ref.object_kind,
    subject,
    version_root: assertContentRoot(ref.version_root, `${label}.version_root`),
    cut_root: assertContentRoot(ref.cut_root, `${label}.cut_root`),
  };
}

export function normalizeTypedReference(value, { kind, status, factWorld = "", cutRoot = "", label }) {
  const reference = assertExactFields(value, TYPED_REFERENCE_FIELDS, label);
  if (reference.kind !== kind) {
    throw new Error(`${label}.kind must be ${kind}`);
  }
  if (reference.status !== status) {
    throw new Error(`${label}.status must be ${status}`);
  }
  const normalized = {
    kind,
    identity: assertString(reference.identity, `${label}.identity`),
    root: assertContentRoot(reference.root, `${label}.root`),
    factWorld: assertString(reference.factWorld, `${label}.factWorld`),
    cutRoot: assertContentRoot(reference.cutRoot, `${label}.cutRoot`),
    schema: assertString(reference.schema, `${label}.schema`),
    status,
  };
  if (factWorld && normalized.factWorld !== factWorld) {
    throw new Error(`${label}.factWorld does not match the Family State v2 fact world`);
  }
  if (cutRoot && normalized.cutRoot !== cutRoot) {
    throw new Error(`${label}.cutRoot does not match the Family State v2 cut`);
  }
  return normalized;
}

export function normalizeFamilyStateReference(value) {
  const reference = assertExactFields(value, [
    "schema",
    "stateRoot",
    "v1ProjectionRoot",
    "typedBindingRoot",
    "factWorld",
    "cutRoot",
  ], "workContext.familyState");
  if (reference.schema !== FAMILY_STATE_V2_SCHEMA) {
    throw new Error(`workContext.familyState.schema must be ${FAMILY_STATE_V2_SCHEMA}`);
  }
  return {
    schema: FAMILY_STATE_V2_SCHEMA,
    stateRoot: assertContentRoot(reference.stateRoot, "workContext.familyState.stateRoot"),
    v1ProjectionRoot: assertContentRoot(reference.v1ProjectionRoot, "workContext.familyState.v1ProjectionRoot"),
    typedBindingRoot: assertContentRoot(reference.typedBindingRoot, "workContext.familyState.typedBindingRoot"),
    factWorld: assertString(reference.factWorld, "workContext.familyState.factWorld"),
    cutRoot: assertContentRoot(reference.cutRoot, "workContext.familyState.cutRoot"),
  };
}

export function normalizeAllowedActions(value, label) {
  if (!Array.isArray(value) || value.some((entry) => !EXECUTION_ACTIONS.has(entry))) {
    throw new Error(`${label} must contain only supported propagation actions`);
  }
  const actions = [...new Set(value)].sort();
  if (JSON.stringify(actions) !== JSON.stringify(value)) {
    throw new Error(`${label} must be a sorted unique array`);
  }
  return actions;
}

export function normalizeWorkAuthority(value, familyState) {
  const authority = assertExactFields(value, [
    "mode",
    "publishToProduction",
    "allowedActions",
    "executionWarrant",
  ], "workContext.authority");
  if (!new Set(["capture-only", "execute"]).has(authority.mode)) {
    throw new Error("workContext.authority.mode must be capture-only or execute");
  }
  if (typeof authority.publishToProduction !== "boolean") {
    throw new Error("workContext.authority.publishToProduction must be a boolean");
  }
  const allowedActions = normalizeAllowedActions(authority.allowedActions, "workContext.authority.allowedActions");
  if (authority.mode === "capture-only") {
    if (authority.executionWarrant !== null || allowedActions.length !== 0) {
      throw new Error("capture-only work cannot carry execution authority");
    }
    return { ...authority, allowedActions };
  }
  if (!authority.publishToProduction) {
    throw new Error("execute authority must explicitly carry publish-to-production intent");
  }
  if (JSON.stringify(allowedActions) !== JSON.stringify([...EXECUTION_ACTIONS].sort())) {
    throw new Error("execute authority must cover the complete propagation stage set");
  }
  return {
    ...authority,
    allowedActions,
    executionWarrant: normalizeTypedReference(authority.executionWarrant, {
      kind: "execution-warrant",
      status: "active",
      factWorld: familyState.factWorld,
      cutRoot: familyState.cutRoot,
      label: "workContext.authority.executionWarrant",
    }),
  };
}
