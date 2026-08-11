// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  discoverConfiguredDerivedVersionMaterial,
  discoverConfiguredVersionStateFiles,
  getVersionStrategy,
  loadBuildchainConfig,
  loadConfiguredAnchorManifest,
  updateConfiguredVersionStateContents,
} from "./buildchain-config.js";

export const NEXT_DEVELOPMENT_TRANSITION_CONTRACT =
  "kungfu-buildchain-next-development-transition/v1";
export const NEXT_DEVELOPMENT_REQUEST_CONTRACT =
  "kungfu-buildchain-next-development-request/v1";
export const NEXT_DEVELOPMENT_ADR =
  "architecture/decisions/0002-next-development-transition.md";
export const NEXT_DEVELOPMENT_INVARIANT =
  "A completed Alpha remains successful and its refs remain immutable while the next-development transition is incomplete.";
export const NEXT_DEVELOPMENT_STATES = Object.freeze([
  "planned",
  "waiting-anchor",
  "materialized",
  "pr-pending",
  "merged",
  "verified",
]);
export const NEXT_DEVELOPMENT_VERSION_MODELS = Object.freeze([
  Object.freeze({ strategy: "semver", next: "auto" }),
  Object.freeze({ strategy: "anchored", next: "manual" }),
]);

const SHA = /^[0-9a-f]{40}$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const ALPHA = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/u;
const TRANSITIONS = new Map([
  ["planned", new Set(["waiting-anchor", "materialized"])],
  ["waiting-anchor", new Set(["materialized"])],
  ["materialized", new Set(["pr-pending", "merged", "verified"])],
  ["pr-pending", new Set(["merged"])],
  ["merged", new Set(["verified"])],
  ["verified", new Set()],
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function nextDevelopmentRoot(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

function contentRoot(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!ROOT.test(normalized))
    throw new Error(`${label} must be a sha256 content root`);
  return normalized;
}

function exactSha(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!SHA.test(normalized))
    throw new Error(`${label} must be an exact 40-character Git SHA`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = String(value || "").trim();
  const milliseconds = Date.parse(normalized);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== normalized
  ) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return normalized;
}

function repository(value) {
  const normalized = String(value || "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(normalized))
    throw new Error("repository must be owner/repo");
  return normalized;
}

function relativePath(value, label) {
  const normalized = String(value || "")
    .trim()
    .replaceAll("\\", "/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized === "." ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be an unambiguous repository-relative path`);
  }
  return normalized;
}

function sortedPaths(values, label) {
  if (!Array.isArray(values) || values.length === 0)
    throw new Error(`${label} must be a non-empty array`);
  const normalized = values.map((value, index) =>
    relativePath(value, `${label}[${index}]`),
  );
  const expected = [...new Set(normalized)].sort();
  if (
    expected.length !== normalized.length ||
    expected.some((value, index) => value !== normalized[index])
  ) {
    throw new Error(`${label} must be sorted and duplicate-free`);
  }
  return normalized;
}

function optionalSortedPaths(values, label) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  if (values.length === 0) return [];
  return sortedPaths(values, label);
}

function normalizeModel(value = {}) {
  const model = {
    strategy: String(value.strategy || "").trim(),
    next: String(value.next || "").trim(),
  };
  const legal = NEXT_DEVELOPMENT_VERSION_MODELS.some(
    (candidate) =>
      candidate.strategy === model.strategy && candidate.next === model.next,
  );
  if (!legal) {
    throw new Error(
      "next-development version model must be semver/auto or anchored/manual",
    );
  }
  return model;
}

function normalizeCompletedAlpha(value = {}) {
  const version = String(value.version || "").trim();
  if (!ALPHA.test(version))
    throw new Error("completedAlpha.version must be an alpha semantic version");
  const exactTag = String(value.exactTag || "").trim();
  if (exactTag !== `v${version}`)
    throw new Error(
      "completedAlpha.exactTag must match completedAlpha.version",
    );
  const normalized = {
    outcome: String(value.outcome || "").trim(),
    version,
    exactTag,
    releaseSha: exactSha(value.releaseSha, "completedAlpha.releaseSha"),
    treeSha: exactSha(value.treeSha, "completedAlpha.treeSha"),
    publicationRoot: contentRoot(
      value.publicationRoot,
      "completedAlpha.publicationRoot",
    ),
    completedAt: timestamp(value.completedAt, "completedAlpha.completedAt"),
  };
  if (normalized.outcome !== "succeeded") {
    throw new Error('completedAlpha.outcome must be "succeeded"');
  }
  return normalized;
}

function deriveAutoVersion(alphaVersion) {
  const match = alphaVersion.match(ALPHA);
  return `${match[1]}.${match[2]}.${match[3]}-alpha.${Number(match[4]) + 1}`;
}

function normalizeAdapter(input = {}) {
  const sourcePaths = sortedPaths(
    input.sourcePaths || input.declaredPaths,
    "sourcePaths",
  );
  const derivedPaths = optionalSortedPaths(input.derivedPaths, "derivedPaths");
  const readOnlyPaths = optionalSortedPaths(
    input.readOnlyPaths,
    "readOnlyPaths",
  );
  const roles = [...sourcePaths, ...derivedPaths, ...readOnlyPaths];
  if (new Set(roles).size !== roles.length) {
    throw new Error("adapter path roles must be disjoint");
  }
  return {
    environmentVariable: "BUILDCHAIN_VERSION",
    sourcePaths,
    derivedPaths,
    allowedChangePaths: [...sourcePaths, ...derivedPaths].sort(),
    readOnlyPaths,
    derivationStage: derivedPaths.length > 0 ? "lifecycle.version-state" : null,
    verificationStage: "lifecycle.verify",
  };
}

function normalizeTarget({ model, completedAlpha, targetVersion, anchor }) {
  const requestedVersion = String(targetVersion || "").trim();
  if (model.strategy === "semver") {
    const derived = deriveAutoVersion(completedAlpha.version);
    if (requestedVersion && requestedVersion !== derived) {
      throw new Error(`semver/auto targetVersion must be ${derived}`);
    }
    if (anchor !== undefined && anchor !== null) {
      throw new Error("semver/auto must not declare an anchor");
    }
    return { version: derived, anchor: null };
  }
  if (!requestedVersion && (anchor === undefined || anchor === null)) {
    return { version: null, anchor: null };
  }
  if (!SEMVER.test(requestedVersion)) {
    throw new Error("anchored/manual targetVersion must be a semantic version");
  }
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
    throw new Error("anchored/manual targetVersion requires an anchor");
  }
  return {
    version: requestedVersion,
    anchor: {
      manifestPath: relativePath(anchor.manifestPath, "anchor.manifestPath"),
      manifestRoot: contentRoot(anchor.manifestRoot, "anchor.manifestRoot"),
    },
  };
}

function initialStateRoot(status, idempotencyKey) {
  return nextDevelopmentRoot({ status, generation: 1, idempotencyKey });
}

export function createNextDevelopmentTransition(input = {}) {
  const completedAlpha = normalizeCompletedAlpha(input.completedAlpha);
  const model = normalizeModel(input.model);
  const adapter = normalizeAdapter(input);
  const declaredPaths = [
    ...adapter.sourcePaths,
    ...adapter.derivedPaths,
    ...adapter.readOnlyPaths,
  ].sort();
  const target = normalizeTarget({
    model,
    completedAlpha,
    targetVersion: input.targetVersion,
    anchor: input.anchor,
  });
  const completedAlphaRoot = nextDevelopmentRoot(completedAlpha);
  const identity = {
    contract: NEXT_DEVELOPMENT_TRANSITION_CONTRACT,
    repository: repository(input.repository),
    completedAlphaRoot,
    model,
    adapter,
  };
  const idempotencyKey = nextDevelopmentRoot(identity);
  const status =
    model.strategy === "anchored" && !target.anchor
      ? "waiting-anchor"
      : "planned";
  return {
    schemaVersion: 1,
    contract: NEXT_DEVELOPMENT_TRANSITION_CONTRACT,
    idempotencyKey,
    repository: identity.repository,
    completedAlpha,
    completedAlphaRoot,
    alphaOutcome: "preserved-success",
    model,
    target,
    declaredPaths,
    adapter,
    effectBounds: {
      allowedPaths: adapter.allowedChangePaths,
      refUpdates: [],
      forbiddenRefNamespaces: ["refs/heads/alpha/", "refs/tags/"],
    },
    state: {
      status,
      generation: 1,
      stateRoot: initialStateRoot(status, idempotencyKey),
    },
    materialization: null,
    transitions: [],
  };
}

function transitionRequestRoot(record, request) {
  return nextDevelopmentRoot({
    contract: NEXT_DEVELOPMENT_TRANSITION_CONTRACT,
    idempotencyKey: record.idempotencyKey,
    expectedStateRoot: request.expectedStateRoot,
    from: request.from || record.state.status,
    to: request.to,
    event: request.event,
    evidenceRoot: request.evidenceRoot,
    recordedAt: request.recordedAt,
  });
}

export function advanceNextDevelopmentTransition(record, input = {}) {
  const current = validateNextDevelopmentTransition(record);
  const request = {
    to: String(input.to || "").trim(),
    event: String(input.event || "").trim(),
    expectedStateRoot: contentRoot(
      input.expectedStateRoot,
      "expectedStateRoot",
    ),
    evidenceRoot: contentRoot(input.evidenceRoot, "evidenceRoot"),
    recordedAt: timestamp(input.recordedAt, "recordedAt"),
  };
  if (!request.event) throw new Error("event is required");
  const replay = current.transitions.find(
    (entry) =>
      entry.expectedStateRoot === request.expectedStateRoot &&
      entry.to === request.to &&
      entry.event === request.event &&
      entry.evidenceRoot === request.evidenceRoot &&
      entry.recordedAt === request.recordedAt,
  );
  if (replay) return structuredClone(current);
  if (request.expectedStateRoot !== current.state.stateRoot) {
    throw new Error("next-development transition compare-and-swap failed");
  }
  if (!TRANSITIONS.get(current.state.status)?.has(request.to)) {
    throw new Error(
      `invalid next-development transition: ${current.state.status} -> ${request.to}`,
    );
  }
  if (
    request.to === "waiting-anchor" &&
    current.model.strategy !== "anchored"
  ) {
    throw new Error("only anchored/manual may enter waiting-anchor");
  }
  if (
    ["materialized", "pr-pending", "merged", "verified"].includes(request.to) &&
    !current.materialization
  ) {
    throw new Error(`${request.to} requires materialized declared paths`);
  }
  const requestRoot = transitionRequestRoot(current, request);
  const transitionBody = {
    expectedStateRoot: request.expectedStateRoot,
    from: current.state.status,
    to: request.to,
    event: request.event,
    evidenceRoot: request.evidenceRoot,
    recordedAt: request.recordedAt,
    requestRoot,
  };
  const transition = {
    ...transitionBody,
    transitionRoot: nextDevelopmentRoot(transitionBody),
  };
  const next = structuredClone(current);
  next.transitions.push(transition);
  next.state = {
    status: request.to,
    generation: current.state.generation + 1,
    stateRoot: nextDevelopmentRoot({
      status: request.to,
      generation: current.state.generation + 1,
      priorStateRoot: current.state.stateRoot,
      transitionRoot: transition.transitionRoot,
      idempotencyKey: current.idempotencyKey,
    }),
  };
  return next;
}

function assertLocalDeclaredFile(cwd, relative) {
  const root = fs.realpathSync(cwd);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`declared path escapes checkout: ${relative}`);
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `declared path must be a regular non-symlink file: ${relative}`,
    );
  }
  return target;
}

function fileRoot(content) {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function getDotted(value, dottedKey) {
  return String(dottedKey)
    .split(".")
    .reduce((current, key) => current?.[key], value);
}

function observedVersion(file) {
  if (file.type === "json" || file.type === "toml")
    return getDotted(file.content, file.key);
  return file.source.match(file.pattern)?.groups?.version;
}

export function materializeNextDevelopmentTransition({
  cwd = process.cwd(),
  request,
  write = false,
} = {}) {
  if (!request || request.contract !== NEXT_DEVELOPMENT_REQUEST_CONTRACT) {
    throw new Error(`request must use ${NEXT_DEVELOPMENT_REQUEST_CONTRACT}`);
  }
  const recordedAt = timestamp(request.recordedAt, "recordedAt");
  const resolvedCwd = fs.realpathSync(path.resolve(cwd));
  const loadedConfig = loadBuildchainConfig(resolvedCwd);
  if (!loadedConfig)
    throw new Error(
      "next-development materialization requires buildchain.toml",
    );
  const model = getVersionStrategy(loadedConfig);
  const versionFiles = discoverConfiguredVersionStateFiles(
    resolvedCwd,
    loadedConfig,
  );
  if (versionFiles.length === 0)
    throw new Error(
      "next-development materialization requires declared version.files",
    );
  const derivedFiles = discoverConfiguredDerivedVersionMaterial(
    resolvedCwd,
    loadedConfig,
  );
  const manifest = loadConfiguredAnchorManifest(resolvedCwd, loadedConfig);
  const sourcePaths = versionFiles.map((file) => file.path).sort();
  const derivedPaths = derivedFiles.map((file) => file.path).sort();
  const readOnlyPaths = manifest ? [manifest.path] : [];
  const plan = createNextDevelopmentTransition({
    repository: request.repository,
    completedAlpha: request.completedAlpha,
    model,
    sourcePaths,
    derivedPaths,
    readOnlyPaths,
    targetVersion: request.targetVersion,
    anchor: request.anchor,
  });
  if (plan.state.status === "waiting-anchor") return plan;
  if (write && derivedPaths.length > 0) {
    throw new Error(
      "reference adapter cannot write derived files; the transaction adapter must run lifecycle.version-state and lifecycle.verify with BUILDCHAIN_VERSION",
    );
  }
  if (model.strategy === "anchored") {
    if (!manifest || plan.target.anchor.manifestPath !== manifest.path) {
      throw new Error(
        "anchored/manual anchor must name the configured version.manifest",
      );
    }
    const manifestPath = assertLocalDeclaredFile(resolvedCwd, manifest.path);
    const observedRoot = fileRoot(fs.readFileSync(manifestPath));
    if (observedRoot !== plan.target.anchor.manifestRoot) {
      throw new Error(
        "anchored/manual manifest root does not match the local checkout",
      );
    }
  }
  for (const file of versionFiles) {
    assertLocalDeclaredFile(resolvedCwd, file.path);
    const current = observedVersion(file);
    if (![plan.completedAlpha.version, plan.target.version].includes(current)) {
      throw new Error(
        `${file.path} is neither the completed Alpha nor the planned next version`,
      );
    }
  }
  for (const file of derivedFiles) {
    assertLocalDeclaredFile(resolvedCwd, file.path);
  }
  const updates = updateConfiguredVersionStateContents(
    versionFiles,
    plan.target.version,
  );
  const updateByPath = new Map(updates.map((entry) => [entry.path, entry]));
  const paths = versionFiles.map((file) => {
    const update = updateByPath.get(file.path);
    return {
      path: file.path,
      beforeRoot: fileRoot(file.source),
      afterRoot: fileRoot(update ? update.content : file.source),
      changed: Boolean(update),
    };
  });
  const materializationBody = {
    targetVersion: plan.target.version,
    anchorRoot: plan.target.anchor?.manifestRoot || null,
    paths,
  };
  const next = structuredClone(plan);
  next.materialization = {
    ...materializationBody,
    materializationRoot: nextDevelopmentRoot(materializationBody),
  };
  if (!write) return next;
  for (const update of updates) {
    const target = assertLocalDeclaredFile(resolvedCwd, update.path);
    fs.writeFileSync(target, update.content);
  }
  const evidenceRoot = next.materialization.materializationRoot;
  return advanceNextDevelopmentTransition(next, {
    to: "materialized",
    event: "declared-version-state-written",
    expectedStateRoot: next.state.stateRoot,
    evidenceRoot,
    recordedAt,
  });
}

function recreateTransition(record) {
  return createNextDevelopmentTransition({
    repository: record.repository,
    completedAlpha: record.completedAlpha,
    model: record.model,
    sourcePaths: record.adapter?.sourcePaths,
    derivedPaths: record.adapter?.derivedPaths,
    readOnlyPaths: record.adapter?.readOnlyPaths,
    targetVersion: record.target?.version || undefined,
    anchor: record.target?.anchor || undefined,
  });
}

function assertStaticTransition(record, recreated) {
  for (const field of [
    "idempotencyKey",
    "completedAlphaRoot",
    "alphaOutcome",
  ]) {
    if (record[field] !== recreated[field])
      throw new Error(`next-development ${field} drifted`);
  }
  for (const field of ["adapter", "declaredPaths", "effectBounds", "target"]) {
    if (JSON.stringify(record[field]) !== JSON.stringify(recreated[field])) {
      const label = field === "effectBounds" ? "effect bounds" : field;
      throw new Error(`next-development ${label} drifted`);
    }
  }
  if (!NEXT_DEVELOPMENT_STATES.includes(record.state?.status)) {
    throw new Error("next-development state is invalid");
  }
  if (
    record.alphaOutcome !== "preserved-success" ||
    record.effectBounds.refUpdates.length !== 0
  ) {
    throw new Error(
      "next-development must preserve completed Alpha success and refs",
    );
  }
  if (!Array.isArray(record.transitions)) {
    throw new Error("next-development transitions must be an array");
  }
  if (
    ["materialized", "pr-pending", "merged", "verified"].includes(
      record.state.status,
    ) &&
    record.materialization === null
  ) {
    throw new Error(
      `next-development ${record.state.status} requires materialization`,
    );
  }
}

function assertMaterialization(record) {
  if (record.materialization !== null) {
    const { materializationRoot, ...body } = record.materialization;
    if (materializationRoot !== nextDevelopmentRoot(body)) {
      throw new Error("next-development materialization root drifted");
    }
    const materializedPaths = (record.materialization.paths || []).map(
      (entry) => entry.path,
    );
    if (
      JSON.stringify(materializedPaths) !==
      JSON.stringify(record.adapter.sourcePaths)
    ) {
      throw new Error("next-development materialization escaped source paths");
    }
  }
}

function replayTransitionChain(record, recreated) {
  let status = recreated.state.status;
  let generation = 1;
  let stateRoot = recreated.state.stateRoot;
  for (const [index, transition] of record.transitions.entries()) {
    if (
      transition.expectedStateRoot !== stateRoot ||
      transition.from !== status
    ) {
      throw new Error(
        `next-development transition ${index} compare-and-swap chain drifted`,
      );
    }
    if (!TRANSITIONS.get(status)?.has(transition.to)) {
      throw new Error(
        `next-development transition ${index} has an invalid state edge`,
      );
    }
    const normalized = {
      to: String(transition.to || "").trim(),
      event: String(transition.event || "").trim(),
      expectedStateRoot: contentRoot(
        transition.expectedStateRoot,
        `transitions[${index}].expectedStateRoot`,
      ),
      evidenceRoot: contentRoot(
        transition.evidenceRoot,
        `transitions[${index}].evidenceRoot`,
      ),
      recordedAt: timestamp(
        transition.recordedAt,
        `transitions[${index}].recordedAt`,
      ),
      from: status,
    };
    if (!normalized.event) {
      throw new Error(`next-development transition ${index} event is required`);
    }
    const expectedRequestRoot = transitionRequestRoot(recreated, normalized);
    if (transition.requestRoot !== expectedRequestRoot) {
      throw new Error(
        `next-development transition ${index} request root drifted`,
      );
    }
    const { transitionRoot, ...transitionBody } = transition;
    if (transitionRoot !== nextDevelopmentRoot(transitionBody)) {
      throw new Error(`next-development transition ${index} root drifted`);
    }
    generation += 1;
    const priorStateRoot = stateRoot;
    status = transition.to;
    stateRoot = nextDevelopmentRoot({
      status,
      generation,
      priorStateRoot,
      transitionRoot,
      idempotencyKey: record.idempotencyKey,
    });
  }
  if (
    record.state.status !== status ||
    record.state.generation !== generation ||
    record.state.stateRoot !== stateRoot
  ) {
    throw new Error(
      "next-development state does not match its transition chain",
    );
  }
}

export function validateNextDevelopmentTransition(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("next-development transition must be an object");
  }
  const recreated = recreateTransition(record);
  assertStaticTransition(record, recreated);
  assertMaterialization(record);
  replayTransitionChain(record, recreated);
  return structuredClone(record);
}
