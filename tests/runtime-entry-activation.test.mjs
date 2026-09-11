import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activateExecutionRuntime } from "../packages/core/runtime/entry/activation.js";
import { runtimeEntryProvider } from "../packages/core/runtime/entry/github.js";

test("preparation activates selected bytes and rejects an incorrect acquisition before installing", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-entry-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const runtime = path.join(workspace, ".buildchain/runtime");
  fs.mkdirSync(path.join(runtime, "architecture"), { recursive: true });
  fs.writeFileSync(
    path.join(runtime, "architecture/runtime-entry.json"),
    JSON.stringify({ schema: "buildchain.runtime-entry/v1", protocol: 1 }),
  );
  fs.mkdirSync(path.join(runtime, "dist/site"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "dist/site/buildchain-contract.json"), JSON.stringify({ contractDigest: "sha256:" + "d".repeat(64) }));
  const selection = {
    schema: "buildchain.runtime-selection/v1",
    repository: "kungfu-systems/buildchain",
    protocol: 1,
    sha: "b".repeat(40),
  };
  const calls = [];
  const result = activateExecutionRuntime(
    { selection, workspace },
    {
      readCommit: (directory) => {
        assert.equal(directory, runtime);
        return selection.sha;
      },
      install: (request) => {
        calls.push(request);
        return { nodePath: "/selected/node" };
      },
    },
  );
  assert.equal(result.directory, runtime);
  assert.deepEqual(calls, [
    { directory: runtime, production: true, ignoreScripts: true },
  ]);
  assert.throws(
    () =>
      activateExecutionRuntime(
        { selection, workspace },
        {
          readCommit: () => "a".repeat(40),
          install: () => assert.fail("wrong bytes cannot install"),
        },
      ),
    /different bytes/u,
  );
  assert.throws(() => activateExecutionRuntime({selection: {...selection, contract: {digest: "sha256:" + "e".repeat(64)}}, workspace}, {
    readCommit: () => selection.sha,
    install: () => assert.fail("a mismatched lock cannot install"),
  }), /contract differs/);

});

test("entry reads the consumer lock at the source commit and authorizes a train on the consumer repository", async () => {
  const observations = [];
  const provider = runtimeEntryProvider(
    {
      rest: {
        repos: {
          getContent: async (request) => {
            observations.push(request);
            return {
              data: {
                type: "file",
                encoding: "base64",
                content: Buffer.from('{"contract":"lock"}').toString("base64"),
              },
            };
          },
          getCollaboratorPermissionLevel: async (request) => {
            observations.push(request);
            return { data: { permission: "write" } };
          },
        },
      },
    },
    {
      sourceRepository: "consumer/project",
      sourceSha: "c".repeat(40),
      actor: "maintainer",
      eventName: "workflow_dispatch",
    },
  );
  assert.deepEqual(await provider.readLock(".buildchain/contract-lock.json"), {
    contract: "lock",
  });
  await provider.authorize({ origin: "runtime-parameter" });
  assert.deepEqual(observations, [
    {
      owner: "consumer",
      repo: "project",
      ref: "c".repeat(40),
      path: ".buildchain/contract-lock.json",
    },
    { owner: "consumer", repo: "project", username: "maintainer" },
  ]);
});

test("a failed lock read is not confused with an absent lock", async () => {
  const provider = runtimeEntryProvider(
    {
      rest: {
        repos: {
          getContent: async () => {
            throw Object.assign(new Error("forbidden"), { status: 403 });
          },
        },
      },
    },
    { sourceRepository: "consumer/project", sourceSha: "a".repeat(40) },
  );
  await assert.rejects(provider.readLock("lock.json"), /forbidden/u);
});
