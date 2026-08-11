import assert from "node:assert/strict";
import test from "node:test";

import {
  NEXT_DEVELOPMENT_CONTROLLER_CONTRACT,
  nextDevelopmentControllerRoot,
  runNextDevelopmentController,
  scheduleNextDevelopmentController,
  validateNextDevelopmentController,
} from "../packages/core/next-development-controller.js";
import {
  createNextDevelopmentTransition,
  nextDevelopmentRoot,
} from "../packages/core/next-development-transition.js";

const SHA = (digit) => digit.repeat(40);
const ROOT = (label) => nextDevelopmentRoot({ label });
const RECORDED_AT = "2026-08-11T02:00:00.000Z";

function completedAlpha() {
  return {
    outcome: "succeeded",
    version: "3.0.9-alpha.1",
    exactTag: "v3.0.9-alpha.1",
    releaseSha: SHA("1"),
    treeSha: SHA("2"),
    publicationRoot: ROOT("alpha-publication"),
    completedAt: "2026-08-11T01:00:00.000Z",
  };
}

function transition(overrides = {}) {
  return createNextDevelopmentTransition({
    repository: "kungfu-systems/buildchain",
    completedAlpha: completedAlpha(),
    model: { strategy: "semver", next: "auto" },
    sourcePaths: ["package.json"],
    derivedPaths: ["dist/version.json"],
    ...overrides,
  });
}

class DurableStore {
  records = new Map();
  creates = 0;

  async readChild(key) {
    return structuredClone(this.records.get(key) || null);
  }

  async createChild(key, record) {
    if (!this.records.has(key)) {
      this.records.set(key, structuredClone(record));
      this.creates += 1;
      return { created: true, record: structuredClone(record) };
    }
    return {
      created: false,
      record: structuredClone(this.records.get(key)),
    };
  }

  async compareAndSwapChild(key, expectedRoot, record) {
    const current = this.records.get(key);
    if (!current || current.controllerRoot !== expectedRoot) {
      throw new Error("test durable store compare-and-swap failed");
    }
    this.records.set(key, structuredClone(record));
    return { record: structuredClone(record) };
  }
}

class Executor {
  constructor({
    devSha = SHA("3"),
    merge = true,
    derivedMismatch = false,
    advanceAfterFirstBuild = "",
    readbackDevSha = "",
    loseFirstMaterializationResponse = false,
  } = {}) {
    this.devSha = devSha;
    this.merge = merge;
    this.derivedMismatch = derivedMismatch;
    this.advanceAfterFirstBuild = advanceAfterFirstBuild;
    this.readbackDevSha = readbackDevSha;
    this.loseFirstMaterializationResponse = loseFirstMaterializationResponse;
  }

  builds = 0;
  materializations = new Map();
  pullRequest = null;
  bases = [];

  async readProtectedDev() {
    return { sha: this.devSha };
  }

  async materialize({ operationKey, baseDevSha, targetVersion, adapter }) {
    if (this.materializations.has(operationKey)) {
      return structuredClone(this.materializations.get(operationKey));
    }
    this.builds += 1;
    this.bases.push(baseDevSha);
    const result = {
      baseDevSha,
      commitSha: SHA(String((this.builds + 3) % 10)),
      treeSha: SHA(String((this.builds + 5) % 10)),
      sourceRoots: adapter.sourcePaths.map((filePath) => ({
        path: filePath,
        beforeRoot: ROOT(`before:${baseDevSha}:${filePath}`),
        afterRoot: ROOT(`after:${targetVersion}:${filePath}`),
        version: targetVersion,
      })),
      derivedRoots: adapter.derivedPaths.map((filePath) => ({
        path: filePath,
        root: ROOT(`derived:${targetVersion}:${filePath}`),
      })),
      changedPaths: [...adapter.allowedChangePaths],
      lifecycleEvidenceRoot: ROOT(`lifecycle:${baseDevSha}:${targetVersion}`),
    };
    this.materializations.set(operationKey, structuredClone(result));
    if (this.builds === 1 && this.advanceAfterFirstBuild) {
      this.devSha = this.advanceAfterFirstBuild;
    }
    if (this.builds === 1 && this.loseFirstMaterializationResponse) {
      this.loseFirstMaterializationResponse = false;
      throw new Error("injected materialization response loss");
    }
    return result;
  }

  async ensurePullRequest({ baseBranch, headSha }) {
    this.pullRequest = {
      number: 91,
      url: "https://github.com/kungfu-systems/buildchain/pull/91",
      baseBranch,
      headSha,
      status: this.merge ? "merged" : "open",
      evidenceRoot: ROOT(`pull-request:${headSha}`),
    };
    return structuredClone(this.pullRequest);
  }

  async readPullRequest() {
    return structuredClone(this.pullRequest);
  }

  async readProtectedVersionState({
    sourcePaths,
    derivedPaths,
    targetVersion,
  }) {
    const materialization = [...this.materializations.values()].at(-1);
    return {
      devSha: this.readbackDevSha || this.devSha,
      treeSha: SHA("9"),
      version: targetVersion,
      containsPreparedCommit: true,
      versionRoots: sourcePaths.map((filePath) => ({
        path: filePath,
        root: materialization.sourceRoots.find(
          (entry) => entry.path === filePath,
        ).afterRoot,
      })),
      derivedRoots: derivedPaths.map((filePath) => ({
        path: filePath,
        root: this.derivedMismatch
          ? ROOT(`mismatch:${filePath}`)
          : materialization.derivedRoots.find(
              (entry) => entry.path === filePath,
            ).root,
      })),
      evidenceRoot: ROOT(`readback:${targetVersion}:${this.devSha}`),
    };
  }
}

test("completed Alpha schedules exactly one durable child and identical reruns reuse it", async () => {
  const store = new DurableStore();
  const child = transition();
  const first = await scheduleNextDevelopmentController(
    { transition: child, protectedDevBranch: "dev/v3/v3.0" },
    store,
  );
  const replay = await scheduleNextDevelopmentController(
    { transition: child, protectedDevBranch: "dev/v3/v3.0" },
    store,
  );
  assert.equal(first.contract, NEXT_DEVELOPMENT_CONTROLLER_CONTRACT);
  assert.equal(store.creates, 1);
  assert.deepEqual(replay, first);
  assert.equal(replay.transition.target.version, "3.0.9-alpha.2");
  assert.equal(replay.transition.completedAlpha.outcome, "succeeded");
  assert.equal(replay.alphaOutcome, "preserved-success");
});

test("controller validation rejects a non-canonical protected Dev branch", async () => {
  const store = new DurableStore();
  const scheduled = await scheduleNextDevelopmentController(
    {
      transition: transition(),
      protectedDevBranch: "dev/v3/v3.0",
    },
    store,
  );
  const forged = structuredClone(scheduled);
  forged.protectedDev.branch = " dev/v3/v3.0 ";
  forged.controllerRoot = nextDevelopmentControllerRoot(forged);
  assert.throws(
    () => validateNextDevelopmentController(forged),
    /protected Dev branch drifted/u,
  );
});

test("anchored/manual persists waiting-anchor and resumes only from reviewed input", async () => {
  const store = new DurableStore();
  const executor = new Executor();
  const child = transition({
    model: { strategy: "anchored", next: "manual" },
    readOnlyPaths: ["release.json"],
  });
  const waiting = await runNextDevelopmentController(
    {
      transition: child,
      protectedDevBranch: "dev/v3/v3.0",
      recordedAt: RECORDED_AT,
    },
    { store, executor },
  );
  assert.equal(waiting.transition.state.status, "waiting-anchor");
  assert.equal(waiting.transition.target.version, null);
  assert.equal(executor.builds, 0);

  const verified = await runNextDevelopmentController(
    {
      transition: child,
      protectedDevBranch: "dev/v3/v3.0",
      reviewedInput: {
        targetVersion: "22.1.0",
        anchor: {
          manifestPath: "release.json",
          manifestRoot: ROOT("reviewed-anchor"),
        },
      },
      recordedAt: RECORDED_AT,
    },
    { store, executor },
  );
  assert.equal(verified.transition.target.version, "22.1.0");
  assert.equal(verified.transition.state.status, "verified");
  assert.equal(store.creates, 1);
  assert.equal(executor.builds, 1);
});

test("fresh runner resumes a checkpoint after injected failure without rebuilding", async () => {
  const store = new DurableStore();
  const executor = new Executor({ merge: false });
  const child = transition();
  await assert.rejects(
    () =>
      runNextDevelopmentController(
        {
          transition: child,
          protectedDevBranch: "dev/v3/v3.0",
          recordedAt: RECORDED_AT,
          fault(checkpoint) {
            if (checkpoint === "materialized") {
              throw new Error("injected runner loss");
            }
          },
        },
        { store, executor },
      ),
    /injected runner loss/u,
  );
  assert.equal(executor.builds, 1);

  const resumed = await runNextDevelopmentController(
    {
      transition: child,
      protectedDevBranch: "dev/v3/v3.0",
      recordedAt: RECORDED_AT,
    },
    { store, executor },
  );
  assert.equal(executor.builds, 1);
  assert.equal(resumed.transition.state.status, "pr-pending");
  assert.equal(resumed.transition.completedAlpha.outcome, "succeeded");
  assert.equal(resumed.alphaOutcome, "preserved-success");
});

test("lost materialization response reuses the operation on a fresh runner", async () => {
  const store = new DurableStore();
  const executor = new Executor({ loseFirstMaterializationResponse: true });
  const child = transition();
  await assert.rejects(
    () =>
      runNextDevelopmentController(
        {
          transition: child,
          protectedDevBranch: "dev/v3/v3.0",
          recordedAt: RECORDED_AT,
        },
        { store, executor },
      ),
    /injected materialization response loss/u,
  );
  const resumed = await runNextDevelopmentController(
    {
      transition: child,
      protectedDevBranch: "dev/v3/v3.0",
      recordedAt: RECORDED_AT,
    },
    { store, executor },
  );
  assert.equal(executor.builds, 1);
  assert.equal(resumed.transition.state.status, "verified");
  assert.equal(resumed.transition.completedAlpha.outcome, "succeeded");
});

test("moving protected Dev supersedes stale material and regenerates from the exact latest SHA", async () => {
  const store = new DurableStore();
  const movedDevSha = SHA("7");
  const laterDevSha = SHA("8");
  const executor = new Executor({
    advanceAfterFirstBuild: movedDevSha,
    readbackDevSha: laterDevSha,
  });
  const child = transition();
  const stale = await runNextDevelopmentController(
    {
      transition: child,
      protectedDevBranch: "dev/v3/v3.0",
      recordedAt: RECORDED_AT,
    },
    { store, executor },
  );
  assert.equal(stale.activeAttempt, null);
  assert.equal(stale.attempts[0].status, "superseded");
  assert.equal(stale.transition.state.status, "planned");

  const reconciled = await runNextDevelopmentController(
    {
      transition: child,
      protectedDevBranch: "dev/v3/v3.0",
      recordedAt: RECORDED_AT,
    },
    { store, executor },
  );
  assert.deepEqual(executor.bases, [SHA("3"), movedDevSha]);
  assert.equal(reconciled.activeAttempt.baseDevSha, movedDevSha);
  assert.equal(reconciled.readback.devSha, laterDevSha);
  assert.equal(reconciled.transition.state.status, "verified");
  assert.equal(reconciled.transition.completedAlpha.outcome, "succeeded");
});

test("verified is withheld until protected Dev version and derived roots agree", async () => {
  const store = new DurableStore();
  const executor = new Executor({ derivedMismatch: true });
  const child = transition();
  const mismatched = await runNextDevelopmentController(
    {
      transition: child,
      protectedDevBranch: "dev/v3/v3.0",
      recordedAt: RECORDED_AT,
    },
    { store, executor },
  );
  assert.equal(mismatched.transition.state.status, "merged");
  assert.equal(mismatched.readback.agrees, false);
  assert.equal(mismatched.transition.completedAlpha.outcome, "succeeded");

  executor.derivedMismatch = false;
  const verified = await runNextDevelopmentController(
    {
      transition: child,
      protectedDevBranch: "dev/v3/v3.0",
      recordedAt: RECORDED_AT,
    },
    { store, executor },
  );
  assert.equal(verified.transition.state.status, "verified");
  assert.equal(verified.readback.agrees, true);
  assert.deepEqual(validateNextDevelopmentController(verified), verified);
  assert.equal(executor.builds, 1);
  assert.equal(store.creates, 1);
});
