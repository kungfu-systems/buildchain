// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateNextDevelopmentController } from "../packages/core/next-development-controller.js";
import {
  NEXT_DEVELOPMENT_REQUEST_CONTRACT,
  NEXT_DEVELOPMENT_TRANSITION_CONTRACT,
  materializeNextDevelopmentTransition,
  nextDevelopmentRoot,
} from "../packages/core/next-development-transition.js";

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u;
const ANCHOR_BYTES = '{"upstream":"v22.1.0"}\n';

export const RECORDED_AT = "2026-08-11T02:00:00.000Z";
export const PROTECTED_DEV_BRANCH = "dev/v3/v3.0";
export const HOSTED_READBACK_PATHS = [
  ".buildchain/release-impact.json",
  "dist/site/buildchain-contract.json",
  "package.json",
];

export function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function exactRoot(value, label) {
  const normalized = required(value, label).toLowerCase();
  if (!ROOT.test(normalized)) throw new Error(`${label} must be a sha256 root`);
  return normalized;
}

export function exactSha(value, label) {
  const normalized = required(value, label).toLowerCase();
  if (!SHA.test(normalized)) {
    throw new Error(`${label} must be an exact 40-character Git SHA`);
  }
  return normalized;
}

export function repository(value, label = "repository") {
  const normalized = required(value, label);
  if (!REPOSITORY.test(normalized)) throw new Error(`${label} must be owner/repo`);
  return normalized;
}

export function fixtureSha(label) {
  return nextDevelopmentRoot({ label }).slice("sha256:".length, 40 + 7);
}

function completedAlpha({ runtimeSha, contractRoot, model }) {
  const version = model === "anchored" ? "22.0.0-alpha.1" : "3.0.9-alpha.1";
  return {
    outcome: "succeeded",
    version,
    exactTag: `v${version}`,
    releaseSha: runtimeSha,
    treeSha: fixtureSha(`completed-alpha-tree:${model}`),
    publicationRoot: nextDevelopmentRoot({ runtimeSha, contractRoot, model }),
    completedAt: "2026-08-11T01:00:00.000Z",
  };
}

function adapterCheckout(model, version) {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), `buildchain-next-development-self-dogfood-${model}-`),
  );
  fs.mkdirSync(path.join(cwd, ".buildchain"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain", "buildchain.toml"),
    `schema = 1

[version]
required = true
strategy = "${model === "anchored" ? "anchored" : "semver"}"
next = "${model === "anchored" ? "manual" : "auto"}"
${model === "anchored" ? 'manifest = "release.json"\n' : ""}
[[version.files]]
type = "json"
path = "package.json"
key = "version"
`,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ name: "self-dogfood-fixture", version }, null, 2)}\n`,
  );
  if (model === "anchored") fs.writeFileSync(path.join(cwd, "release.json"), ANCHOR_BYTES);
  return cwd;
}

export function anchorInput() {
  return {
    targetVersion: "22.1.0",
    anchor: {
      manifestPath: "release.json",
      manifestRoot: `sha256:${crypto.createHash("sha256").update(ANCHOR_BYTES).digest("hex")}`,
    },
  };
}

function adapterRequest(route, model, reviewedInput) {
  return {
    contract: NEXT_DEVELOPMENT_REQUEST_CONTRACT,
    repository: route.repository,
    completedAlpha: completedAlpha({ ...route, model }),
    recordedAt: RECORDED_AT,
    ...(reviewedInput || {}),
  };
}

export function adapterTransition(route, model) {
  const alpha = completedAlpha({ ...route, model });
  const cwd = adapterCheckout(model, alpha.version);
  try {
    return materializeNextDevelopmentTransition({
      cwd,
      request: adapterRequest(route, model),
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function operationBody(record) {
  const body = structuredClone(record);
  delete body.operationRoot;
  return body;
}

export function validateAdapterOperation(record) {
  exactRoot(record?.operationKey, "adapter operation key");
  exactRoot(record?.idempotencyKey, "adapter idempotency key");
  exactRoot(record?.materializationRoot, "adapter materialization root");
  if (
    record?.adapterContract !== NEXT_DEVELOPMENT_TRANSITION_CONTRACT ||
    !["semver", "anchored"].includes(record?.model)
  ) {
    throw new Error("real version-state adapter operation contract mismatch");
  }
  if (record.operationRoot !== nextDevelopmentRoot(operationBody(record))) {
    throw new Error("real version-state adapter operation root drifted");
  }
  return structuredClone(record);
}

export function validateSelfDogfoodRoute(route) {
  exactSha(route?.runtimeSha, "route.runtimeSha");
  const targetRepository = repository(route?.repository, "route.repository");
  if (
    targetRepository !== "kungfu-systems/buildchain" ||
    route.runtimeRef !== "v3-alpha" ||
    route.publicWorkflow !==
      `${targetRepository}/.github/workflows/build.yml@v3-alpha` ||
    route.protectedDevBranch !== PROTECTED_DEV_BRANCH ||
    JSON.stringify(route.hostedReadbackPaths) !==
      JSON.stringify(HOSTED_READBACK_PATHS)
  ) {
    throw new Error("next-development evidence public route drifted");
  }
  return targetRepository;
}

export function validateRecoveryEvidence(recovery) {
  const sameRunner =
    required(recovery?.faultRunnerId, "faultRunnerId") ===
    required(recovery?.resumeRunnerId, "resumeRunnerId");
  const unchangedDev =
    exactSha(recovery?.protectedDevMovement?.initialSha, "protected Dev initial SHA") ===
    exactSha(recovery?.protectedDevMovement?.movedSha, "protected Dev moved SHA");
  if (
    recovery?.freshRunner !== true ||
    sameRunner ||
    recovery?.transientDurableStateFailures !== 1 ||
    recovery?.recoveredAdapterOperations !== 1 ||
    recovery?.alphaCandidateRebuilds !== 0 ||
    recovery?.devMaterializationsBefore !== 1 ||
    recovery?.devMaterializationsAfter !== 2 ||
    recovery?.protectedDevMovement?.supersededAttempts !== 1 ||
    unchangedDev ||
    recovery?.protectedPrDelay?.status !== "pr-pending" ||
    recovery?.protectedPrDelay?.delayedStatus !== "pr-pending" ||
    recovery?.protectedPrDelay?.unchangedControllerRoot !== true
  ) {
    throw new Error("fresh-runner failure, Dev movement, or protected-PR delay proof is incomplete");
  }
}

export function validateAdapterEvidence(adapter, semver, anchored) {
  const operations = adapter?.operations || [];
  operations.forEach(validateAdapterOperation);
  const expectedKeys = [...semver.attempts, ...anchored.attempts]
    .map((entry) => entry.operationKey)
    .sort();
  const observedKeys = operations.map((entry) => entry.operationKey).sort();
  if (
    adapter?.boundary !== "materializeNextDevelopmentTransition" ||
    adapter?.contract !== NEXT_DEVELOPMENT_TRANSITION_CONTRACT ||
    operations.length !== 3 ||
    new Set(operations.map((entry) => entry.model)).size !== 2 ||
    JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys)
  ) {
    throw new Error("real version-state adapter boundary proof is incomplete");
  }
}

export class DurableStore {
  constructor(records = [], { transientFailures = 0 } = {}) {
    this.records = new Map(
      records.map((record) => {
        const current = validateNextDevelopmentController(record);
        return [current.childKey, current];
      }),
    );
    this.transientFailuresRemaining = transientFailures;
    this.transientFailures = 0;
  }

  async readChild(key) {
    return structuredClone(this.records.get(key) || null);
  }

  async createChild(key, record) {
    if (!this.records.has(key)) this.records.set(key, structuredClone(record));
    return { record: structuredClone(this.records.get(key)) };
  }

  async compareAndSwapChild(key, expectedRoot, record) {
    if (this.transientFailuresRemaining > 0) {
      this.transientFailuresRemaining -= 1;
      this.transientFailures += 1;
      throw new Error("injected transient durable-state write failure");
    }
    const current = this.records.get(key);
    if (!current || current.controllerRoot !== expectedRoot) {
      throw new Error("self-dogfood durable store compare-and-swap failed");
    }
    this.records.set(key, structuredClone(record));
    return { record: structuredClone(record) };
  }

  only() {
    if (this.records.size !== 1) {
      throw new Error("self-dogfood durable store expected exactly one child");
    }
    return structuredClone([...this.records.values()][0]);
  }
}

export class VersionStateAdapterHarness {
  constructor({
    route,
    operations = [],
    devSha = fixtureSha("protected-dev:initial"),
    movedDevSha = "",
    moveAfterRecoveredOperation = false,
    pullRequestReadsBeforeMerge = 0,
  } = {}) {
    this.operations = new Map(
      operations.map((record) => {
        const current = validateAdapterOperation(record);
        return [current.operationKey, current];
      }),
    );
    this.route = route ? structuredClone(route) : null;
    this.devSha = devSha;
    this.movedDevSha = movedDevSha;
    this.moveAfterRecoveredOperation = moveAfterRecoveredOperation;
    this.pullRequestReadsBeforeMerge = pullRequestReadsBeforeMerge;
    this.materializations = operations.length;
    this.recoveredOperations = 0;
    this.pullRequestReads = 0;
    this.pullRequest = null;
  }

  async readProtectedDev() {
    return { sha: this.devSha };
  }

  async materialize({ operationKey, repository: targetRepository, baseDevSha, targetVersion, anchor }) {
    const existing = this.operations.get(operationKey);
    if (existing) {
      this.recoveredOperations += 1;
      if (this.moveAfterRecoveredOperation && this.movedDevSha) {
        this.devSha = this.movedDevSha;
        this.moveAfterRecoveredOperation = false;
      }
      return structuredClone(existing.result);
    }
    const model = anchor ? "anchored" : "semver";
    const route = this.route || {
      repository: targetRepository,
      runtimeSha: model === "anchored" ? fixtureSha("anchored-runtime") : fixtureSha("semver-runtime"),
      contractRoot: nextDevelopmentRoot({ model, targetRepository }),
    };
    const alpha = completedAlpha({ ...route, model });
    const cwd = adapterCheckout(model, alpha.version);
    let materialized;
    try {
      materialized = materializeNextDevelopmentTransition({
        cwd,
        request: adapterRequest(
          route,
          model,
          model === "anchored" ? { targetVersion, anchor } : undefined,
        ),
        write: true,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
    if (materialized.state.status !== "materialized" || materialized.target.version !== targetVersion) {
      throw new Error("real version-state adapter did not materialize the target");
    }
    const result = {
      baseDevSha,
      commitSha: fixtureSha(`prepared:${operationKey}:${materialized.materialization.materializationRoot}`),
      treeSha: fixtureSha(`prepared-tree:${operationKey}:${materialized.materialization.materializationRoot}`),
      sourceRoots: materialized.materialization.paths.map((entry) => ({
        path: entry.path,
        beforeRoot: entry.beforeRoot,
        afterRoot: entry.afterRoot,
        version: targetVersion,
      })),
      derivedRoots: [],
      changedPaths: materialized.materialization.paths
        .filter((entry) => entry.changed)
        .map((entry) => entry.path)
        .sort(),
      lifecycleEvidenceRoot: materialized.materialization.materializationRoot,
    };
    const record = {
      operationKey,
      model,
      adapterContract: materialized.contract,
      idempotencyKey: materialized.idempotencyKey,
      materializationRoot: materialized.materialization.materializationRoot,
      result,
    };
    record.operationRoot = nextDevelopmentRoot(record);
    this.operations.set(operationKey, validateAdapterOperation(record));
    this.materializations += 1;
    return structuredClone(result);
  }

  async ensurePullRequest({ baseBranch, headSha }) {
    this.pullRequest = {
      number: 91,
      url: "https://github.com/kungfu-systems/buildchain/pull/91",
      baseBranch,
      headSha,
      status: "open",
      evidenceRoot: nextDevelopmentRoot({ baseBranch, headSha, pullRequest: 91 }),
    };
    return structuredClone(this.pullRequest);
  }

  async readPullRequest({ number }) {
    if (!this.pullRequest) throw new Error(`self-dogfood pull request ${number} was not restored`);
    this.pullRequestReads += 1;
    if (this.pullRequestReads > this.pullRequestReadsBeforeMerge) {
      this.pullRequest.status = "merged";
      this.devSha = fixtureSha(`protected-merge:${this.pullRequest.headSha}`);
    }
    return structuredClone(this.pullRequest);
  }

  async readProtectedVersionState({ sourcePaths, derivedPaths, targetVersion, preparedCommitSha }) {
    const operation = [...this.operations.values()].find(
      (entry) => entry.result.commitSha === preparedCommitSha,
    );
    if (!operation) throw new Error("protected readback has no rooted adapter operation");
    const sourceRoots = Object.fromEntries(
      operation.result.sourceRoots.map((entry) => [entry.path, entry.afterRoot]),
    );
    const derivedRoots = Object.fromEntries(
      operation.result.derivedRoots.map((entry) => [entry.path, entry.root]),
    );
    const body = {
      branch: PROTECTED_DEV_BRANCH,
      devSha: this.devSha,
      preparedCommitSha,
      targetVersion,
      versionRoots: sourcePaths.map((filePath) => ({ path: filePath, root: sourceRoots[filePath] })),
      derivedRoots: derivedPaths.map((filePath) => ({ path: filePath, root: derivedRoots[filePath] })),
    };
    return {
      devSha: this.devSha,
      treeSha: fixtureSha(`protected-readback-tree:${preparedCommitSha}`),
      version: targetVersion,
      containsPreparedCommit: true,
      versionRoots: body.versionRoots,
      derivedRoots: body.derivedRoots,
      evidenceRoot: nextDevelopmentRoot(body),
    };
  }

  operationRecords() {
    return [...this.operations.values()].map((entry) => structuredClone(entry));
  }
}
