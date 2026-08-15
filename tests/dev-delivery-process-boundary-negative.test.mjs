import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { devDeliveryContentRoot } from "../packages/core/dev-delivery-common.js";
import {
  createNativeExecutionTransfer,
  createProviderFinalizerBoundary,
  verifyNativeExecutionTransfer,
  verifyProviderFailureSettlementBinding,
} from "../packages/core/dev-delivery-process-boundary.js";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;
const RUNTIME_SHA = "f".repeat(40);

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function byteRoot(file) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

function reroot(value, rootField, mutate) {
  const body = structuredClone(value);
  delete body[rootField];
  mutate(body);
  return { ...body, [rootField]: devDeliveryContentRoot(body) };
}

function failedTransfer(directory) {
  writeJson(path.join(directory, "warrant.json"), {
    schema: "kungfu.buildchain.dev-delivery-command-result/v1",
    observation: {
      repository: "kungfu-systems/buildchain",
      protectedBase: "dev/v4/v4.0",
      stateRoot: ROOT("1"),
      activeWarrant: {
        candidateId: ROOT("2"),
        fencingToken: ROOT("3"),
        generation: 4,
        pullRequestNumber: 123,
        sourceHead: "a".repeat(40),
      },
    },
  });
  writeJson(path.join(directory, "native-job-context.json"), {
    schema: "kungfu.buildchain.native-job-context/v1",
    workflowRunId: 42,
    workflowRunAttempt: 3,
    job: "native-execution",
    runnerEnvironment: "github-hosted",
    runnerName: "GitHub Actions 1001",
    runnerOs: "Linux",
    runnerArch: "X64",
    outcome: "failed",
    evidenceCompletedAt: "2026-08-15T01:00:00.000Z",
  });
  writeJson(path.join(directory, "runtime-selection.json"), {
    schema: "kungfu.buildchain.dev-delivery-runtime-selection/v1",
    repository: "kungfu-systems/buildchain",
    selector: "v4-alpha",
    resolvedSha: RUNTIME_SHA,
  });
  const runtimeSelectionRoot = byteRoot(
    path.join(directory, "runtime-selection.json"),
  );
  const failure = {
    schema: "kungfu.buildchain.two-phase-delivery-failure/v1",
    pullRequestNumber: 123,
    expectedHead: "a".repeat(40),
    fencingToken: ROOT("3"),
    leaseGeneration: 4,
    nativeAttempts: 1,
    reason: "native command failed",
    workerTerminationProven: true,
  };
  failure.evidenceRoot = devDeliveryContentRoot(failure);
  writeJson(path.join(directory, "failure.json"), failure);
  writeJson(path.join(directory, "failure-provider-settlement.json"), {
    schema: "kungfu.buildchain.two-phase-provider-settlement-required/v1",
    evidenceRoot: failure.evidenceRoot,
    stateRoot: ROOT("1"),
    candidateId: ROOT("2"),
    fencingToken: ROOT("3"),
    leaseGeneration: 4,
    pullRequestNumber: 123,
    sourceHead: "a".repeat(40),
    workerTerminationProven: true,
    nextAction: "Settle through the verified provider boundary.",
  });
  const transfer = createNativeExecutionTransfer({
    directory,
    files: [
      "warrant.json",
      "failure.json",
      "failure-provider-settlement.json",
      "native-job-context.json",
      "runtime-selection.json",
    ],
    outcome: "failed",
    producer: {
      workflowRunId: 42,
      workflowRunAttempt: 3,
      job: "native-execution",
      runnerEnvironment: "github-hosted",
      runnerName: "GitHub Actions 1001",
      runnerOs: "Linux",
      runnerArch: "X64",
    },
    sealer: {
      job: "seal-native-execution",
      runnerEnvironment: "github-hosted",
      runnerName: "GitHub Actions 2002",
      runnerOs: "Linux",
      runnerArch: "X64",
    },
    runtime: {
      repository: "kungfu-systems/buildchain",
      selector: "v4-alpha",
      resolvedSha: RUNTIME_SHA,
      selectionRoot: runtimeSelectionRoot,
    },
    warrant: {
      repository: "kungfu-systems/buildchain",
      protectedBase: "dev/v4/v4.0",
      stateRoot: ROOT("1"),
      candidateId: ROOT("2"),
      fencingToken: ROOT("3"),
      generation: 4,
      pullRequestNumber: 123,
      sourceHead: "a".repeat(40),
    },
    completedAt: "2026-08-15T01:00:00Z",
    sealedAt: "2026-08-15T01:00:03Z",
  });
  writeJson(path.join(directory, "execution-transfer.json"), transfer);
  return transfer;
}

function failedBoundary(transfer) {
  return createProviderFinalizerBoundary({
    jobs: [
      {
        id: 501,
        run_attempt: 3,
        name: "delivery / Credentialless native execution",
        status: "completed",
        conclusion: "failure",
        runner_name: "GitHub Actions 1001",
        runner_group_name: "GitHub Actions",
        labels: ["ubuntu-24.04"],
        started_at: "2026-08-15T00:59:00Z",
        completed_at: "2026-08-15T01:00:01Z",
      },
      {
        id: 502,
        run_attempt: 3,
        name: "delivery / Credentialless native evidence seal",
        status: "completed",
        conclusion: "success",
        runner_name: "GitHub Actions 2002",
        runner_group_name: "GitHub Actions",
        labels: ["ubuntu-24.04"],
        started_at: "2026-08-15T01:00:02Z",
        completed_at: "2026-08-15T01:00:04Z",
      },
      {
        id: 503,
        run_attempt: 3,
        name: "delivery / Credentialed provider finalizer",
        status: "in_progress",
        conclusion: null,
        runner_name: "GitHub Actions 3003",
        runner_group_name: "GitHub Actions",
        labels: ["ubuntu-24.04"],
        started_at: "2026-08-15T01:00:05Z",
      },
    ],
    executionTransfer: transfer,
    workflowRunId: 42,
    workflowRunAttempt: 3,
    nativeJobName: "Credentialless native execution",
    sealJobName: "Credentialless native evidence seal",
    finalizerJobName: "Credentialed provider finalizer",
    finalizerRunnerName: "GitHub Actions 3003",
    finalizerRunnerEnvironment: "github-hosted",
    pullRequestReadback: {
      number: 123,
      state: "open",
      head: { sha: "a".repeat(40) },
      base: {
        ref: "dev/v4/v4.0",
        repo: { full_name: "kungfu-systems/buildchain" },
      },
    },
    baseRefReadback: {
      ref: "refs/heads/dev/v4/v4.0",
      object: { type: "commit", sha: "b".repeat(40) },
    },
    observedAt: "2026-08-15T01:00:06Z",
  });
}

test("canonical failure bytes cannot be replaced and rerooted after sealing", () => {
  for (const relative of ["failure.json", "failure-provider-settlement.json"]) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "delivery-canonical-failure-"),
    );
    const sealed = failedTransfer(directory);
    const file = path.join(directory, relative);
    fs.writeFileSync(
      file,
      `${JSON.stringify(JSON.parse(fs.readFileSync(file)))}\n`,
    );
    const replay = reroot(sealed, "transferRoot", (body) => {
      body.files.find((entry) => entry.path === relative).byteRoot =
        byteRoot(file);
    });
    writeJson(path.join(directory, "execution-transfer.json"), replay);
    assert.throws(
      () => verifyNativeExecutionTransfer(replay, { directory }),
      /not canonical JSON bytes/u,
      relative,
    );
  }
});

test("the second recursive snapshot rejects mutation during download verification", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-second-snapshot-"),
  );
  const sealed = failedTransfer(directory);
  const original = fs.readFileSync;
  let failureReads = 0;
  fs.readFileSync = function patchedRead(file, ...args) {
    const bytes = original.call(this, file, ...args);
    if (path.basename(String(file)) === "failure.json") {
      failureReads += 1;
      if (failureReads === 2) {
        fs.writeFileSync(path.join(directory, "post-read-extra.json"), "{}\n");
      }
    }
    return bytes;
  };
  try {
    assert.throws(
      () => verifyNativeExecutionTransfer(sealed, { directory }),
      /membership mismatch/u,
    );
  } finally {
    fs.readFileSync = original;
  }
});

test("failure settlement rejects mismatched or replayed chain coordinates", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-failure-chain-"),
  );
  const transfer = verifyNativeExecutionTransfer(failedTransfer(directory), {
    directory,
  });
  const boundary = failedBoundary(transfer);
  const settlement = verifyProviderFailureSettlementBinding(boundary, transfer);
  assert.deepEqual(
    Object.keys(settlement).filter((field) =>
      [
        "transferRoot",
        "finalizerBoundaryRoot",
        "nativeJobId",
        "sealJobId",
      ].includes(field),
    ),
    ["transferRoot", "nativeJobId", "sealJobId", "finalizerBoundaryRoot"],
  );
  assert.equal(Object.hasOwn(settlement, "executionTransferRoot"), false);
  assert.equal(
    Object.hasOwn(settlement, "providerFinalizerBoundaryRoot"),
    false,
  );
  const mismatches = {
    evidenceRoot: ROOT("8"),
    transferRoot: ROOT("8"),
    boundaryRoot: ROOT("8"),
    finalizerBoundaryRoot: ROOT("8"),
    nativeJobId: 777,
    warrantStateRoot: ROOT("8"),
    fencingToken: ROOT("8"),
  };
  for (const [field, value] of Object.entries(mismatches)) {
    assert.throws(
      () =>
        verifyProviderFailureSettlementBinding(boundary, transfer, {
          [field]: value,
        }),
      new RegExp(`${field} mismatch`, "u"),
      field,
    );
  }

  const replayedJob = reroot(boundary, "boundaryRoot", (body) => {
    body.nativeJob.id = 777;
    body.failureSettlement.nativeJobId = 777;
  });
  assert.throws(
    () =>
      verifyProviderFailureSettlementBinding(replayedJob, transfer, {
        nativeJobId: 501,
      }),
    /nativeJobId mismatch/u,
  );
});
