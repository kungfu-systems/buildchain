import assert from "node:assert/strict";
import test from "node:test";
import { runtimeEntryProvider } from "../packages/core/runtime/entry/github.js";

function provider(permission, calls = [], context = {}) {
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
      ...context,
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
test("GitHub-authorized dispatch accepts users and installation actors without a collaborator lookup", async () => {
  for (const actor of [
    "maintainer",
    "github-actions[bot]",
    "release-installation[bot]",
  ]) {
    const calls = [];
    await provider("none", calls, {
      actor,
      eventName: "workflow_dispatch",
    }).authorize({
      origin: "runtime-parameter",
    });
    assert.deepEqual(calls, []);
  }
});
test("other events retain override authorization for every actor, including bots", async () => {
  for (const eventName of [
    "pull_request",
    "workflow_run",
    "push",
    "repository_dispatch",
    undefined,
  ]) {
    for (const actor of ["reader", "github-actions[bot]"]) {
      const calls = [];
      await assert.rejects(
        provider("read", calls, { actor, eventName }).authorize({
          origin: "runtime-parameter",
        }),
        /write permission/u,
      );
      assert.deepEqual(calls, [
        { owner: "consumer", repo: "project", username: actor },
      ]);
    }
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
