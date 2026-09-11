import assert from "node:assert/strict";
import test from "node:test";
import {
  preparedRuntimeSelection,
  runtimeSelector,
  selectExecutionRuntime,
} from "../packages/core/runtime/entry/selection.js";

const entry = "a".repeat(40);
const locked = "b".repeat(40);
const repaired = "c".repeat(40);
const lock = {
  schemaVersion: 1,
  contract: "kungfu-buildchain-contract-lock",
  buildchain: { ref: "v4", resolvedSha: locked, contractDigest: "sha256:" + "d".repeat(64) },
};
const protocol = { schema: "buildchain.runtime-entry/v1", protocol: 1 };

test("entry defaults to its commit but a lock independently selects execution code", () => {
  assert.deepEqual(runtimeSelector({ workflowSha: entry }), {
    ref: entry,
    origin: "workflow-default",
  });
  assert.deepEqual(runtimeSelector({ workflowSha: entry, lock }), {
    ref: locked,
    origin: "contract-lock",
  });
});

test("a transient train overrides the lock, resolves once and leaves persisted inputs unchanged", async () => {
  const input = {
    workflowSha: entry,
    lock,
    runtimeRef: "train/v4/v4.1/runtime-repair",
  };
  const original = structuredClone(input);
  const observations = [];
  const selection = await selectExecutionRuntime(input, {
    authorize: async (request) => observations.push(["authorize", request.ref]),
    resolveRef: async (request) => {
      observations.push(["resolve", request.ref]);
      return repaired;
    },
    readProtocol: async ({ sha }) => {
      assert.equal(sha, repaired);
      return protocol;
    },
  });
  assert.equal(selection.sha, repaired);
  assert.notEqual(selection.sha, entry);
  assert.notEqual(selection.sha, lock.buildchain.resolvedSha);
  assert.deepEqual(input, original);
  assert.deepEqual(
    observations.map(([operation]) => operation),
    ["authorize", "resolve"],
  );
  assert.deepEqual(preparedRuntimeSelection(selection), selection);
});

test("entry rejects an invalid lock instead of silently selecting another runtime", () => {
  assert.throws(
    () => runtimeSelector({ lock: {}, workflowSha: entry }),
    /contract lock/u,
  );
  assert.throws(
    () =>
      runtimeSelector({
        lock: { ...lock, buildchain: {} },
        workflowSha: entry,
      }),
    /exact commit/u,
  );
  assert.throws(
    () => runtimeSelector({ runtimeRef: "feature/unadmitted" }),
    /Runtime parameter/u,
  );
});

test("entry refuses an unauthorized runtime before resolving or loading it", async () => {
  await assert.rejects(
    selectExecutionRuntime(
      { runtimeRef: "train/v4/v4.1/repair" },
      {
        authorize: async () => {
          throw new Error("not authorized");
        },
        resolveRef: async () => assert.fail("must not resolve"),
        readProtocol: async () => assert.fail("must not load"),
      },
    ),
    /not authorized/u,
  );
});

test("incompatible runtimes require an entry/runtime upgrade without a checkout fallback", async () => {
  await assert.rejects(
    selectExecutionRuntime(
      { workflowSha: entry, lock },
      {
        authorize: async () => {},
        resolveRef: async () => assert.fail("locked runtime is already exact"),
        readProtocol: async () => ({ protocol: 99 }),
      },
    ),
    /entry protocol/u,
  );
  assert.throws(
    () =>
      preparedRuntimeSelection({
        schema: "buildchain.runtime-selection/v1",
        repository: "other/repo",
        protocol: 1,
        sha: repaired,
      }),
    /Unsupported/u,
  );
});
