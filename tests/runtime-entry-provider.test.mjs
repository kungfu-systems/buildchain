import assert from "node:assert/strict";
import test from "node:test";
import { runtimeEntryProvider } from "../packages/core/runtime/entry/github.js";

function provider(permission, calls = []) {
  return runtimeEntryProvider(
    {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: async (request) => {
            calls.push(request);
            return {
              data: {
                permission,
                user: { permissions: { push: permission === "write" } },
              },
            };
          },
          getContent: async () => {
            throw Object.assign(new Error("network failure"), { status: 503 });
          },
        },
      },
    },
    {
      sourceRepository: "consumer/project",
      sourceSha: "a".repeat(40),
      actor: "maintainer",
    },
  );
}

test("runtime override authorizes the consumer actor exactly at the entry", async () => {
  for (const permission of ["write", "maintain", "admin"]) {
    const calls = [];
    await provider(permission, calls).authorize({
      origin: "runtime-parameter",
    });
    assert.deepEqual(calls, [
      { owner: "consumer", repo: "project", username: "maintainer" },
    ]);
  }
});
test("read-only and unknown actors cannot select execution code", async () => {
  for (const permission of ["read", "triage", "none", ""]) {
    await assert.rejects(
      provider(permission).authorize({ origin: "runtime-parameter" }),
      /write permission/,
    );
  }
});
test("locked and workflow-default selections do not invent override authorization", async () => {
  const calls = [];
  for (const origin of ["contract-lock", "workflow-default"])
    await provider("read", calls).authorize({ origin });
  assert.deepEqual(calls, []);
});
test("a failed lock read cannot fall back to a different execution runtime", async () => {
  await assert.rejects(
    provider("write").readLock(".buildchain/contract-lock.json"),
    /network failure/,
  );
});
