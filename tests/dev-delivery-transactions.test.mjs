import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { writeJson } from "../packages/core/dev-delivery/native/files.js";
import { executeDeliveryNative } from "../packages/core/dev-delivery/native/transactions.js";
import { qualifyDeliverySource } from "../packages/core/dev-delivery/candidate/admission.js";
import { settleNativeFailure } from "../packages/core/dev-delivery/warrant/failure-settlement.js";
import { settleTerminalDelivery } from "../packages/core/dev-delivery/warrant/terminal.js";
const root = (digit) => `sha256:${digit.repeat(64)}`;
const sha = "a".repeat(40);
function fixture(t) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-transaction-"),
  );
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return {
    workspace,
    file: (name) => path.join(workspace, ".buildchain", name),
  };
}
test("failed source qualification retains rooted runtime evidence without issuing a source proof", async (t) => {
  const { workspace, file } = fixture(t);
  let derived = false;
  const result = await qualifyDeliverySource(
    {
      workspace,
      runtimeSha: sha,
      repository: "owner/repo",
      branch: "dev/v4/v4.1",
      request: {
        "buildchain-repository": "kungfu-systems/buildchain",
        "buildchain-ref": "v4-alpha",
        "delivery-warrant-mode": "shadow",
        "dry-run": true,
      },
    },
    {
      admit: async () => {
        throw new Error("provider qualification rejected");
      },
      derivePaths: () => {
        derived = true;
      },
    },
  );
  assert.equal(result["qualify-outcome"], "failure");
  assert.equal(result["proof-outcome"], "skipped");
  const bytes = fs.readFileSync(file("dev-delivery/runtime-selection.json"));
  assert.equal(
    result["runtime-root"],
    `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
  );
  assert.equal(fs.existsSync(file("dev-delivery/source-proof.json")), false);
  assert.equal(derived, false);
  assert.match(
    fs.readFileSync(
      file("dev-delivery/source-qualification-error.json"),
      "utf8",
    ),
    /provider qualification rejected/u,
  );
});
test("runtime byte drift prevents native execution and records a failed producer context", async (t) => {
  const { workspace, file } = fixture(t);
  let ran = false;
  writeJson(file("dev-delivery/runtime-selection.json"), { resolvedSha: sha });
  await assert.rejects(
    executeDeliveryNative(
      {
        workspace,
        runtimeSha: sha,
        runtimeSelectionRoot: root("0"),
        candidate: {},
        run: { id: 42, attempt: 2 },
        runner: {
          name: "runner-1",
          environment: "github-hosted",
          os: "Linux",
          arch: "X64",
        },
      },
      {
        runNative: () => {
          ran = true;
        },
      },
    ),
    /runtime selection differs/u,
  );
  assert.equal(ran, false);
  const context = JSON.parse(
    fs.readFileSync(file("dev-delivery/native-job-context.json"), "utf8"),
  );
  assert.equal(context.outcome, "failed");
  assert.equal(context.workflowRunAttempt, 2);
});
test("native failure settlement requires live CAS and never accepts provider coordinates from transferred data", async (t) => {
  const { workspace, file } = fixture(t);
  const requests = [];
  const settlement = {
    pullRequestNumber: 7,
    sourceHead: sha,
    fencingToken: root("1"),
    leaseGeneration: 2,
    evidenceRoot: root("2"),
    reason: "native failed",
    transferRoot: root("3"),
    finalizerBoundaryRoot: root("4"),
    nativeJobId: 10,
    sealJobId: 11,
    repository: "wrong/repo",
    branch: "dev/v9/v9.9",
    apiUrl: "https://wrong.invalid",
    token: "untrusted-marker",
  };
  writeJson(file("provider-failure-settlement.json"), settlement);
  writeJson(file("provider-heartbeat-verification.json"), {});
  const service = {
    settle: async (request) => {
      requests.push(request);
      return {
        ok: true,
        receipt: { ...request, expectedOldStateRoot: root("5") },
        observation: {
          activeWarrant: null,
          candidates: [
            { pullRequestNumber: 7, sourceHead: sha, terminal: { ...request } },
          ],
        },
      };
    },
  };
  await assert.rejects(
    settleNativeFailure({ workspace }, service),
    /latest heartbeat state root/u,
  );
  assert.equal(requests.length, 0);
  writeJson(file("provider-heartbeat-verification.json"), {
    latestStateRoot: root("5"),
  });
  await settleNativeFailure({ workspace }, service);
  assert.equal(requests[0].expectedOldStateRoot, root("5"));
  for (const key of ["repository", "branch", "apiUrl", "token"])
    assert.equal(Object.hasOwn(requests[0], key), false);
});
test("successor wake occurs after durable settlement and cannot erase its receipt on failure", async (t) => {
  const { workspace, file } = fixture(t);
  const order = [];
  const candidate = {
    pullRequestNumber: 7,
    sourceHead: sha,
    candidateId: root("1"),
  };
  const service = {
    observe: async () => ({
      observation: {
        activeWarrant: { ...candidate, fencingToken: root("2"), generation: 3 },
        activeCandidate: candidate,
      },
    }),
    settle: async (request) => {
      order.push("settle");
      assert.equal(request.fencingToken, root("2"));
      assert.equal(request.leaseGeneration, 3);
      return {
        receiptRoot: root("3"),
        after: { stateRoot: root("4") },
        receipt: {
          successorWake: {
            pullRequestNumber: 8,
            sourceHead: "b".repeat(40),
            sourceWorkflowRunId: 12,
            affectedPaths: ["large.js"],
          },
        },
      };
    },
  };
  await assert.rejects(
    settleTerminalDelivery(
      {
        workspace,
        request: {
          branch: "dev/v4/v4.1",
          outcome: "cancelled",
          pullRequestNumber: 7,
          expectedSourceHead: sha,
          evidenceRoot: root("5"),
          reason: "cancelled",
        },
        connection: { repository: "owner/repo" },
      },
      {
        service,
        onSettlement: () => order.push("receipt"),
        provider: {
          request: async (_endpoint, { body }) => {
            order.push("wake");
            assert.deepEqual(body.client_payload.candidate.affectedPaths, []);
            throw new Error("dispatch unavailable");
          },
        },
      },
    ),
    /dispatch unavailable/u,
  );
  assert.deepEqual(order, ["settle", "receipt", "wake"]);
  assert.equal(
    JSON.parse(fs.readFileSync(file("dev-delivery/close.json"), "utf8"))
      .receiptRoot,
    root("3"),
  );
});
