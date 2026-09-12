import test from "node:test";
import assert from "node:assert/strict";
import { consumerContractLock } from "../packages/core/consumer/contract/identity.js";
import {
  runtimeSelector,
  selectExecutionRuntime,
} from "../packages/core/runtime/entry/selection.js";

test("minimal managed lock selects its exact runtime through the common entry protocol", async () => {
  const lock = consumerContractLock({
    entry: { repository: "kungfu-systems/buildchain", sha: "a".repeat(40) },
    runtime: { repository: "kungfu-systems/buildchain", sha: "b".repeat(40) },
    configDigest: `sha256:${"c".repeat(64)}`,
  });
  const calls = [];
  const selection = await selectExecutionRuntime(
    { lock, workflowSha: "d".repeat(40) },
    {
      authorize: async (request) => calls.push(request),
      readProtocol: async ({ sha }) => {
        assert.equal(sha, lock.runtime.sha);
        return { schema: "buildchain.runtime-entry/v1", protocol: 1 };
      },
      resolveRef: async () => {
        throw new Error("Locked runtime must not float");
      },
    },
  );
  assert.equal(selection.sha, lock.runtime.sha);
  assert.equal(selection.origin, "consumer-contract-lock");
  assert.equal(selection.class, "exact-sha");
  assert.equal(selection.contract.consumerConfigDigest, lock.configDigest);
  assert.equal(calls.length, 1);
  assert.throws(
    () => runtimeSelector({ lock: { ...lock, override: true } }),
    /unsupported fields/,
  );
  assert.throws(
    () =>
      runtimeSelector({
        lock: {
          ...lock,
          runtime: { ...lock.runtime, repository: "attacker/runtime" },
        },
      }),
    /untrusted/,
  );
  assert.equal(
    runtimeSelector({ lock, runtimeRef: "train/v4/v4.1/repair" }).origin,
    "runtime-parameter",
  );
});
