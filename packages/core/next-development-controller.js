// SPDX-License-Identifier: Apache-2.0

import {
  advanceNextDevelopmentTransition,
  bindNextDevelopmentAnchor,
  nextDevelopmentRoot,
  recordNextDevelopmentMaterialization,
  validateNextDevelopmentTransition,
} from "./next-development-transition.js";

export const NEXT_DEVELOPMENT_CONTROLLER_CONTRACT =
  "kungfu-buildchain-next-development-controller/v1";

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;

function exactRoot(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!ROOT.test(normalized)) {
    throw new Error(`${label} must be a sha256 content root`);
  }
  return normalized;
}

function exactSha(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!SHA.test(normalized)) {
    throw new Error(`${label} must be an exact 40-character Git SHA`);
  }
  return normalized;
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function protectedBranch(value) {
  const normalized = requiredString(value, "protectedDev.branch");
  if (
    normalized.startsWith("refs/") ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("..") ||
    /\s/u.test(normalized)
  ) {
    throw new Error("protectedDev.branch must be an unambiguous branch name");
  }
  return normalized;
}

function sortedUnique(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const normalized = values.map((value, index) =>
    requiredString(value, `${label}[${index}]`),
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

function rootedPaths(values, expectedPaths, label, { version = false } = {}) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const normalized = values.map((entry, index) => ({
    path: requiredString(entry?.path, `${label}[${index}].path`),
    root: exactRoot(entry?.root, `${label}[${index}].root`),
    ...(version
      ? {
          version: requiredString(entry?.version, `${label}[${index}].version`),
        }
      : {}),
  }));
  normalized.sort((left, right) => left.path.localeCompare(right.path));
  if (
    JSON.stringify(normalized.map((entry) => entry.path)) !==
    JSON.stringify(expectedPaths)
  ) {
    throw new Error(`${label} must exactly cover its declared paths`);
  }
  return normalized;
}

function controllerBody(record) {
  const body = structuredClone(record);
  delete body.controllerRoot;
  return body;
}

export function nextDevelopmentControllerRoot(record) {
  return nextDevelopmentRoot(controllerBody(record));
}

export function nextDevelopmentChildKey(transition) {
  const current = validateNextDevelopmentTransition(transition);
  return nextDevelopmentRoot({
    contract: NEXT_DEVELOPMENT_CONTROLLER_CONTRACT,
    repository: current.repository,
    completedAlphaRoot: current.completedAlphaRoot,
  });
}

function refreshController(record) {
  const next = structuredClone(record);
  next.controllerRoot = nextDevelopmentControllerRoot(next);
  return next;
}

export function createNextDevelopmentController({
  transition,
  protectedDevBranch,
} = {}) {
  const child = validateNextDevelopmentTransition(transition);
  if (!["planned", "waiting-anchor"].includes(child.state.status)) {
    throw new Error(
      "new next-development controller requires an initial child transition",
    );
  }
  return refreshController({
    schemaVersion: 1,
    contract: NEXT_DEVELOPMENT_CONTROLLER_CONTRACT,
    childKey: nextDevelopmentChildKey(child),
    idempotencyKey: child.idempotencyKey,
    repository: child.repository,
    protectedDev: { branch: protectedBranch(protectedDevBranch) },
    completedAlphaRoot: child.completedAlphaRoot,
    alphaOutcome: "preserved-success",
    revision: 1,
    transition: child,
    attempts: [],
    activeAttempt: null,
    pullRequest: null,
    readback: null,
  });
}

function normalizeSourceRoots(values, expectedPaths, targetVersion) {
  if (!Array.isArray(values)) {
    throw new Error("materialization.sourceRoots must be an array");
  }
  const normalized = values
    .map((entry, index) => ({
      path: requiredString(
        entry?.path,
        `materialization.sourceRoots[${index}].path`,
      ),
      beforeRoot: exactRoot(
        entry?.beforeRoot,
        `materialization.sourceRoots[${index}].beforeRoot`,
      ),
      afterRoot: exactRoot(
        entry?.afterRoot,
        `materialization.sourceRoots[${index}].afterRoot`,
      ),
      version: requiredString(
        entry?.version,
        `materialization.sourceRoots[${index}].version`,
      ),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    JSON.stringify(normalized.map((entry) => entry.path)) !==
    JSON.stringify(expectedPaths)
  ) {
    throw new Error(
      "materialization.sourceRoots must exactly cover declared source paths",
    );
  }
  if (normalized.some((entry) => entry.version !== targetVersion)) {
    throw new Error(
      "materialization source versions must equal the declared successor",
    );
  }
  return normalized;
}

function normalizeMaterialization(record, value, baseDevSha, operationKey) {
  const transition = record.transition;
  const sourceRoots = normalizeSourceRoots(
    value?.sourceRoots,
    transition.adapter.sourcePaths,
    transition.target.version,
  );
  const derivedRoots = rootedPaths(
    value?.derivedRoots || [],
    transition.adapter.derivedPaths,
    "materialization.derivedRoots",
  );
  const changedPaths = sortedUnique(
    value?.changedPaths || [],
    "materialization.changedPaths",
  );
  const unexpected = changedPaths.filter(
    (changedPath) =>
      !transition.adapter.allowedChangePaths.includes(changedPath),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `materialization changed paths outside declared version state: ${unexpected.join(", ")}`,
    );
  }
  const normalized = {
    operationKey,
    generation: record.attempts.length + 1,
    status: "prepared",
    baseDevSha: exactSha(value?.baseDevSha, "materialization.baseDevSha"),
    preparedCommitSha: exactSha(value?.commitSha, "materialization.commitSha"),
    preparedTreeSha: exactSha(value?.treeSha, "materialization.treeSha"),
    targetVersion: transition.target.version,
    sourceRoots,
    derivedRoots,
    changedPaths,
    lifecycleEvidenceRoot: exactRoot(
      value?.lifecycleEvidenceRoot,
      "materialization.lifecycleEvidenceRoot",
    ),
  };
  if (normalized.baseDevSha !== baseDevSha) {
    throw new Error(
      "materialization must be regenerated from the exact observed protected Dev SHA",
    );
  }
  normalized.materializationRoot = nextDevelopmentRoot({
    baseDevSha: normalized.baseDevSha,
    preparedCommitSha: normalized.preparedCommitSha,
    preparedTreeSha: normalized.preparedTreeSha,
    targetVersion: normalized.targetVersion,
    sourceRoots: normalized.sourceRoots,
    derivedRoots: normalized.derivedRoots,
    changedPaths: normalized.changedPaths,
    lifecycleEvidenceRoot: normalized.lifecycleEvidenceRoot,
  });
  return normalized;
}

function normalizePullRequest(record, value, attempt) {
  const number = Number(value?.number);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("pullRequest.number must be a positive integer");
  }
  const status = requiredString(value?.status, "pullRequest.status");
  if (!["open", "merged"].includes(status)) {
    throw new Error("pullRequest.status must be open or merged");
  }
  const normalized = {
    number,
    url: requiredString(value?.url, "pullRequest.url"),
    baseBranch: protectedBranch(value?.baseBranch),
    headSha: exactSha(value?.headSha, "pullRequest.headSha"),
    status,
    evidenceRoot: exactRoot(value?.evidenceRoot, "pullRequest.evidenceRoot"),
  };
  if (
    normalized.baseBranch !== record.protectedDev.branch ||
    normalized.headSha !== attempt.preparedCommitSha
  ) {
    throw new Error(
      "pull request must bind the protected Dev branch and prepared commit",
    );
  }
  return normalized;
}

function normalizeReadback(record, value, attempt) {
  const normalized = {
    devSha: exactSha(value?.devSha, "readback.devSha"),
    treeSha: exactSha(value?.treeSha, "readback.treeSha"),
    version: requiredString(value?.version, "readback.version"),
    containsPreparedCommit: value?.containsPreparedCommit === true,
    versionRoots: rootedPaths(
      value?.versionRoots,
      record.transition.adapter.sourcePaths,
      "readback.versionRoots",
    ),
    derivedRoots: rootedPaths(
      value?.derivedRoots || [],
      record.transition.adapter.derivedPaths,
      "readback.derivedRoots",
    ),
    evidenceRoot: exactRoot(value?.evidenceRoot, "readback.evidenceRoot"),
  };
  const expectedVersionRoots = attempt.sourceRoots.map(
    ({ path, afterRoot }) => ({
      path,
      root: afterRoot,
    }),
  );
  normalized.agrees =
    normalized.containsPreparedCommit &&
    normalized.version === record.transition.target.version &&
    JSON.stringify(normalized.versionRoots) ===
      JSON.stringify(expectedVersionRoots) &&
    JSON.stringify(normalized.derivedRoots) ===
      JSON.stringify(attempt.derivedRoots);
  return normalized;
}

function normalizedAttempt(record, attempt, index) {
  const normalized = normalizeMaterialization(
    { ...record, attempts: Array(index).fill(null) },
    {
      baseDevSha: attempt?.baseDevSha,
      commitSha: attempt?.preparedCommitSha,
      treeSha: attempt?.preparedTreeSha,
      sourceRoots: attempt?.sourceRoots,
      derivedRoots: attempt?.derivedRoots,
      changedPaths: attempt?.changedPaths,
      lifecycleEvidenceRoot: attempt?.lifecycleEvidenceRoot,
    },
    attempt?.baseDevSha,
    exactRoot(attempt?.operationKey, `attempts[${index}].operationKey`),
  );
  if (
    !["prepared", "pr-pending", "merged", "superseded"].includes(
      attempt?.status,
    )
  ) {
    throw new Error(`attempts[${index}].status is invalid`);
  }
  normalized.status = attempt.status;
  if (attempt.materializationRoot !== normalized.materializationRoot) {
    throw new Error(`attempts[${index}].materializationRoot drifted`);
  }
  return normalized;
}

function validateControllerObservations(record, attempts) {
  let activeAttempt = null;
  if (record.activeAttempt !== null) {
    activeAttempt = attempts.find(
      (attempt) => attempt.operationKey === record.activeAttempt.operationKey,
    );
    if (
      !activeAttempt ||
      JSON.stringify(activeAttempt) !== JSON.stringify(record.activeAttempt)
    ) {
      throw new Error("next-development controller active attempt drifted");
    }
  }
  if (record.pullRequest !== null) {
    if (!activeAttempt) {
      throw new Error(
        "next-development controller pull request requires an active attempt",
      );
    }
    const pullRequest = normalizePullRequest(
      record,
      record.pullRequest,
      activeAttempt,
    );
    if (JSON.stringify(pullRequest) !== JSON.stringify(record.pullRequest)) {
      throw new Error("next-development controller pull request drifted");
    }
  }
  if (record.readback !== null) {
    if (!activeAttempt) {
      throw new Error(
        "next-development controller readback requires an active attempt",
      );
    }
    const readback = normalizeReadback(record, record.readback, activeAttempt);
    if (JSON.stringify(readback) !== JSON.stringify(record.readback)) {
      throw new Error("next-development controller readback drifted");
    }
  }
  if (
    record.transition.state.status === "verified" &&
    (!record.readback?.agrees || !activeAttempt)
  ) {
    throw new Error(
      "verified next-development controller requires agreeing protected Dev readback",
    );
  }
}

export function validateNextDevelopmentController(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("next-development controller must be an object");
  }
  if (record.contract !== NEXT_DEVELOPMENT_CONTROLLER_CONTRACT) {
    throw new Error("next-development controller contract mismatch");
  }
  if (record.schemaVersion !== 1) {
    throw new Error("next-development controller schemaVersion must be 1");
  }
  const transition = validateNextDevelopmentTransition(record.transition);
  const expectedChildKey = nextDevelopmentChildKey(transition);
  if (
    record.childKey !== expectedChildKey ||
    record.idempotencyKey !== transition.idempotencyKey ||
    record.repository !== transition.repository ||
    record.completedAlphaRoot !== transition.completedAlphaRoot
  ) {
    throw new Error("next-development controller child identity drifted");
  }
  if (protectedBranch(record.protectedDev?.branch) !== record.protectedDev.branch) {
    throw new Error("next-development controller protected Dev branch drifted");
  }
  if (
    record.alphaOutcome !== "preserved-success" ||
    transition.alphaOutcome !== "preserved-success" ||
    transition.completedAlpha.outcome !== "succeeded"
  ) {
    throw new Error("next-development controller invalidated completed Alpha");
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new Error("next-development controller revision must be positive");
  }
  if (!Array.isArray(record.attempts)) {
    throw new Error("next-development controller attempts must be an array");
  }
  const attempts = record.attempts.map((attempt, index) =>
    normalizedAttempt(record, attempt, index),
  );
  if (
    new Set(attempts.map((attempt) => attempt.operationKey)).size !==
    attempts.length
  ) {
    throw new Error(
      "next-development controller attempt operation keys must be unique",
    );
  }
  validateControllerObservations(record, attempts);
  if (record.controllerRoot !== nextDevelopmentControllerRoot(record)) {
    throw new Error("next-development controller root drifted");
  }
  return structuredClone(record);
}

function assertStore(store) {
  for (const method of ["readChild", "createChild", "compareAndSwapChild"]) {
    if (typeof store?.[method] !== "function") {
      throw new Error(`next-development durable store requires ${method}`);
    }
  }
}

function assertExecutor(executor) {
  for (const method of [
    "readProtectedDev",
    "materialize",
    "ensurePullRequest",
    "readPullRequest",
    "readProtectedVersionState",
  ]) {
    if (typeof executor?.[method] !== "function") {
      throw new Error(`next-development executor requires ${method}`);
    }
  }
}

function assertSameScheduledChild(existing, requested) {
  const current = validateNextDevelopmentController(existing);
  if (
    current.childKey !== requested.childKey ||
    current.idempotencyKey !== requested.idempotencyKey ||
    current.protectedDev.branch !== requested.protectedDev.branch
  ) {
    throw new Error(
      "durable next-development child conflicts with the completed Alpha schedule",
    );
  }
  return current;
}

export async function scheduleNextDevelopmentController(
  { transition, protectedDevBranch } = {},
  store,
) {
  assertStore(store);
  const requested = createNextDevelopmentController({
    transition,
    protectedDevBranch,
  });
  const existing = await store.readChild(requested.childKey);
  if (existing) return assertSameScheduledChild(existing, requested);
  const created = await store.createChild(requested.childKey, requested);
  if (!created?.record) {
    throw new Error("durable store createChild must return the stored record");
  }
  return assertSameScheduledChild(created.record, requested);
}

async function persist(record, store) {
  const expectedRoot = exactRoot(record?.controllerRoot, "controllerRoot");
  const current = structuredClone(record);
  current.controllerRoot = nextDevelopmentControllerRoot(current);
  validateNextDevelopmentController(current);
  const next = structuredClone(current);
  next.revision += 1;
  next.controllerRoot = nextDevelopmentControllerRoot(next);
  const stored = await store.compareAndSwapChild(
    next.childKey,
    expectedRoot,
    next,
  );
  return validateNextDevelopmentController(stored?.record || stored);
}

function replaceActiveAttempt(record, attempt) {
  const next = structuredClone(record);
  const index = next.attempts.findIndex(
    (candidate) => candidate.operationKey === attempt.operationKey,
  );
  if (index < 0) next.attempts.push(attempt);
  else next.attempts[index] = attempt;
  next.activeAttempt = attempt.status === "superseded" ? null : attempt;
  return next;
}

async function checkpoint(fault, name, record) {
  if (typeof fault === "function") await fault(name, structuredClone(record));
}

function transitionMaterialization(attempt, transition) {
  const body = {
    targetVersion: transition.target.version,
    anchorRoot: transition.target.anchor?.manifestRoot || null,
    paths: attempt.sourceRoots.map((entry) => ({
      path: entry.path,
      beforeRoot: entry.beforeRoot,
      afterRoot: entry.afterRoot,
      changed: entry.beforeRoot !== entry.afterRoot,
    })),
  };
  return {
    ...body,
    materializationRoot: nextDevelopmentRoot(body),
  };
}

function transitionEvidence(attempt) {
  return nextDevelopmentRoot({
    materializationRoot: attempt.materializationRoot,
    lifecycleEvidenceRoot: attempt.lifecycleEvidenceRoot,
  });
}

export async function reconcileNextDevelopmentController(
  record,
  { store, executor, reviewedInput, recordedAt, fault } = {},
) {
  assertStore(store);
  assertExecutor(executor);
  let current = validateNextDevelopmentController(record);
  if (current.transition.state.status === "verified") return current;

  if (
    current.transition.state.status === "waiting-anchor" &&
    !current.transition.target.version
  ) {
    if (!reviewedInput) return current;
    current.transition = bindNextDevelopmentAnchor(
      current.transition,
      reviewedInput,
    );
    current = await persist(current, store);
    await checkpoint(fault, "anchor-bound", current);
  }

  if (!current.activeAttempt) {
    const observed = await executor.readProtectedDev({
      repository: current.repository,
      branch: current.protectedDev.branch,
    });
    const baseDevSha = exactSha(observed?.sha, "protectedDev.sha");
    const operationKey = nextDevelopmentRoot({
      childKey: current.childKey,
      baseDevSha,
      target: current.transition.target,
    });
    const materialized = await executor.materialize({
      operationKey,
      repository: current.repository,
      branch: current.protectedDev.branch,
      baseDevSha,
      targetVersion: current.transition.target.version,
      anchor: current.transition.target.anchor,
      adapter: structuredClone(current.transition.adapter),
    });
    const attempt = normalizeMaterialization(
      current,
      materialized,
      baseDevSha,
      operationKey,
    );
    current = replaceActiveAttempt(current, attempt);
    current = await persist(current, store);
    await checkpoint(fault, "materialized", current);
  }

  let attempt = current.activeAttempt;
  const latest = await executor.readProtectedDev({
    repository: current.repository,
    branch: current.protectedDev.branch,
  });
  const latestDevSha = exactSha(latest?.sha, "protectedDev.sha");
  if (latestDevSha !== attempt.baseDevSha && !current.pullRequest) {
    attempt = { ...attempt, status: "superseded" };
    current = replaceActiveAttempt(current, attempt);
    current = await persist(current, store);
    await checkpoint(fault, "dev-advanced", current);
    return current;
  }

  if (["planned", "waiting-anchor"].includes(current.transition.state.status)) {
    current.transition = recordNextDevelopmentMaterialization(
      current.transition,
      {
        materialization: transitionMaterialization(attempt, current.transition),
        evidenceRoot: transitionEvidence(attempt),
        recordedAt,
      },
    );
    current = await persist(current, store);
    await checkpoint(fault, "materialization-recorded", current);
  }

  if (!current.pullRequest) {
    const ensured = await executor.ensurePullRequest({
      operationKey: current.childKey,
      repository: current.repository,
      baseBranch: current.protectedDev.branch,
      headSha: attempt.preparedCommitSha,
      targetVersion: current.transition.target.version,
      completedAlphaRoot: current.completedAlphaRoot,
    });
    current.pullRequest = normalizePullRequest(current, ensured, attempt);
    attempt = { ...attempt, status: "pr-pending" };
    current = replaceActiveAttempt(current, attempt);
    if (current.transition.state.status === "materialized") {
      current.transition = advanceNextDevelopmentTransition(
        current.transition,
        {
          to: "pr-pending",
          event: "protected-version-pr-opened",
          expectedStateRoot: current.transition.state.stateRoot,
          evidenceRoot: current.pullRequest.evidenceRoot,
          recordedAt,
        },
      );
    }
    current = await persist(current, store);
    await checkpoint(fault, "pull-request-recorded", current);
  }

  const pullRequest = normalizePullRequest(
    current,
    await executor.readPullRequest({
      repository: current.repository,
      number: current.pullRequest.number,
    }),
    current.activeAttempt,
  );
  current.pullRequest = pullRequest;
  if (pullRequest.status !== "merged") return current;
  if (current.transition.state.status === "pr-pending") {
    current.transition = advanceNextDevelopmentTransition(current.transition, {
      to: "merged",
      event: "protected-version-pr-merged",
      expectedStateRoot: current.transition.state.stateRoot,
      evidenceRoot: pullRequest.evidenceRoot,
      recordedAt,
    });
    attempt = { ...current.activeAttempt, status: "merged" };
    current = replaceActiveAttempt(current, attempt);
    current = await persist(current, store);
    await checkpoint(fault, "merge-recorded", current);
  }

  const readback = normalizeReadback(
    current,
    await executor.readProtectedVersionState({
      repository: current.repository,
      branch: current.protectedDev.branch,
      sourcePaths: current.transition.adapter.sourcePaths,
      derivedPaths: current.transition.adapter.derivedPaths,
      targetVersion: current.transition.target.version,
      preparedCommitSha: current.activeAttempt.preparedCommitSha,
    }),
    current.activeAttempt,
  );
  current.readback = readback;
  if (!readback.agrees) {
    current = await persist(current, store);
    await checkpoint(fault, "readback-mismatch", current);
    return current;
  }
  current.transition = advanceNextDevelopmentTransition(current.transition, {
    to: "verified",
    event: "protected-dev-version-state-readback-verified",
    expectedStateRoot: current.transition.state.stateRoot,
    evidenceRoot: readback.evidenceRoot,
    recordedAt,
  });
  current = await persist(current, store);
  await checkpoint(fault, "verified", current);
  return current;
}

export async function runNextDevelopmentController(
  { transition, protectedDevBranch, reviewedInput, recordedAt, fault } = {},
  { store, executor } = {},
) {
  const scheduled = await scheduleNextDevelopmentController(
    { transition, protectedDevBranch },
    store,
  );
  await checkpoint(fault, "scheduled", scheduled);
  return reconcileNextDevelopmentController(scheduled, {
    store,
    executor,
    reviewedInput,
    recordedAt,
    fault,
  });
}
