import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createNativeExecutionTransfer,
  createNativeExecutionSealBinding,
  createProviderFinalizerBoundary,
  isCredentialVariableName,
  stageNativeExecutionTransfer,
  verifyNativeExecutionTransfer,
  verifyProviderFailureSettlementBinding,
} from "../packages/core/dev-delivery-process-boundary.js";
import { devDeliveryContentRoot } from "../packages/core/dev-delivery-common.js";
import {
  createNativeCommandContract,
  createNativeExecutionReceipt,
  createNativeProofReuseDecision,
  createNativeQualificationProof,
} from "../packages/core/dev-delivery-warrant.js";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;
const RUNTIME_SHA = "f".repeat(40);
const NATIVE_COMMAND = "pnpm run native";
const NATIVE_COMMAND_CONTRACT = createNativeCommandContract(NATIVE_COMMAND);
const OBSERVER = path.resolve(
  import.meta.dirname,
  "fixtures/detached-credential-observer.mjs",
);

function persistTransfer(directory, transfer) {
  fs.writeFileSync(
    path.join(directory, "execution-transfer.json"),
    `${JSON.stringify(transfer, null, 2)}\n`,
  );
  return transfer;
}

function writeJson(directory, name, value) {
  fs.writeFileSync(
    path.join(directory, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function runtimeFixture(directory) {
  const selection = {
    schema: "kungfu.buildchain.dev-delivery-runtime-selection/v1",
    repository: "kungfu-systems/buildchain",
    selector: "v4-alpha",
    resolvedSha: RUNTIME_SHA,
  };
  writeJson(directory, "runtime-selection.json", selection);
  return {
    ...selection,
    selectionRoot: fileRoot(path.join(directory, "runtime-selection.json")),
  };
}

function warrantFixture(directory) {
  const warrant = {
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v4/v4.0",
    candidateId: ROOT("2"),
    fencingToken: ROOT("3"),
    generation: 4,
    pullRequestNumber: 123,
    sourceHead: "a".repeat(40),
    qualifiedBase: "b".repeat(40),
    sourceIdentityRoot: ROOT("6"),
    sourcePatchRoot: ROOT("7"),
    planRoot: ROOT("8"),
    closureRoot: ROOT("9"),
    dependencyRoot: ROOT("a"),
    toolchainRoot: ROOT("b"),
    environmentRoot: ROOT("c"),
    nativeCommandContract: NATIVE_COMMAND_CONTRACT,
    affectedPaths: ["packages/native"],
    shardEvidenceRoots: [ROOT("d")],
  };
  writeJson(directory, "warrant.json", {
    schema: "kungfu.buildchain.dev-delivery-command-result/v1",
    observation: {
      repository: warrant.repository,
      protectedBase: warrant.protectedBase,
      stateRoot: ROOT("1"),
      activeWarrant: Object.fromEntries(
        Object.entries(warrant).filter(([field]) => field !== "qualifiedBase"),
      ),
    },
  });
  return warrant;
}

function nativeProofFixture(warrant) {
  const receipt = createNativeExecutionReceipt({
    outcome: "succeeded",
    commandRoot: NATIVE_COMMAND_CONTRACT.commandRoot,
    executionBinding: {
      repository: warrant.repository,
      protectedBase: warrant.protectedBase,
      sourceHead: warrant.sourceHead,
      qualifiedBase: warrant.qualifiedBase,
      nativeCommandRoot: NATIVE_COMMAND_CONTRACT.commandRoot,
      toolchainRoot: warrant.toolchainRoot,
      environmentRoot: warrant.environmentRoot,
    },
    startedAt: "2026-08-15T00:59:10Z",
    completedAt: "2026-08-15T00:59:59Z",
    heartbeatCount: 2,
  });
  const proof = createNativeQualificationProof({
    ...warrant,
    nativeCommandRoot: NATIVE_COMMAND_CONTRACT.commandRoot,
    nativeExecutionReceipt: receipt,
    qualifiedAt: "2026-08-15T01:00:00Z",
  });
  const decision = createNativeProofReuseDecision({
    proof,
    current: {
      sourceHead: warrant.sourceHead,
      sourceIdentityRoot: warrant.sourceIdentityRoot,
      sourcePatchRoot: warrant.sourcePatchRoot,
      planRoot: warrant.planRoot,
      closureRoot: warrant.closureRoot,
      dependencyRoot: warrant.dependencyRoot,
      toolchainRoot: warrant.toolchainRoot,
      environmentRoot: warrant.environmentRoot,
      nativeCommandRoot: NATIVE_COMMAND_CONTRACT.commandRoot,
      currentBase: warrant.qualifiedBase,
      graphKnown: true,
      attributionComplete: true,
      changedPaths: [],
      renames: [],
    },
  });
  return { proof, decision };
}

function nativeContextFixture(directory, outcome) {
  const context = {
    schema: "kungfu.buildchain.native-job-context/v1",
    workflowRunId: 42,
    workflowRunAttempt: 3,
    job: "native-execution",
    runnerEnvironment: "github-hosted",
    runnerName: "GitHub Actions 1001",
    runnerOs: "Linux",
    runnerArch: "X64",
    outcome,
    evidenceCompletedAt: "2026-08-15T01:00:00.000Z",
  };
  writeJson(directory, "native-job-context.json", context);
  return context;
}

function transferFixture(directory, overrides = {}) {
  const warrant = warrantFixture(directory);
  const runtime = runtimeFixture(directory);
  nativeContextFixture(directory, "succeeded");
  const { proof, decision } = nativeProofFixture(warrant);
  writeJson(directory, "native-proof.json", proof);
  writeJson(directory, "native-reuse-decision.json", decision);
  writeJson(directory, "two-phase-native-result.json", {
    nativeProofRoot: proof.proofRoot,
    nativeReuseDecisionRoot: decision.decisionRoot,
  });
  return persistTransfer(
    directory,
    createNativeExecutionTransfer({
      directory,
      files: [
        "warrant.json",
        "native-job-context.json",
        "native-proof.json",
        "native-reuse-decision.json",
        "runtime-selection.json",
        "two-phase-native-result.json",
      ],
      outcome: "succeeded",
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
      runtime,
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
      nativeProofRoot: proof.proofRoot,
      nativeReuseDecisionRoot: decision.decisionRoot,
      completedAt: "2026-08-15T01:00:00Z",
      sealedAt: "2026-08-15T01:00:03Z",
      ...overrides,
    }),
  );
}

function jobsFixture(nativeRunner = "GitHub Actions 1001") {
  return [
    {
      id: 501,
      run_attempt: 3,
      name: "delivery / Credentialless native execution",
      status: "completed",
      conclusion: "success",
      runner_name: nativeRunner,
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
  ];
}

function providerSourceFixture(overrides = {}) {
  return {
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
    ...overrides,
  };
}

test("credential ancestry classifies GitHub artifact runtime authority", () => {
  assert.equal(isCredentialVariableName("ACTIONS_RUNTIME_TOKEN"), true);
});

function boundaryFixture(transfer, overrides = {}) {
  return {
    jobs: jobsFixture(),
    executionTransfer: transfer,
    workflowRunId: 42,
    workflowRunAttempt: 3,
    nativeJobName: "Credentialless native execution",
    sealJobName: "Credentialless native evidence seal",
    finalizerJobName: "Credentialed provider finalizer",
    finalizerRunnerName: "GitHub Actions 3003",
    finalizerRunnerEnvironment: "github-hosted",
    observedAt: "2026-08-15T01:00:06Z",
    ...providerSourceFixture(),
    ...overrides,
  };
}

function rerootTransfer(transfer, mutate) {
  const body = structuredClone(transfer);
  delete body.transferRoot;
  mutate(body);
  return { ...body, transferRoot: devDeliveryContentRoot(body) };
}

function fileRoot(file) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

function failedTransferFixture(directory) {
  warrantFixture(directory);
  const runtime = runtimeFixture(directory);
  nativeContextFixture(directory, "failed");
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
  fs.writeFileSync(
    path.join(directory, "failure.json"),
    `${JSON.stringify(failure, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(directory, "failure-provider-settlement.json"),
    `${JSON.stringify({ schema: "kungfu.buildchain.two-phase-provider-settlement-required/v1", evidenceRoot: failure.evidenceRoot, stateRoot: ROOT("1"), candidateId: ROOT("2"), fencingToken: ROOT("3"), leaseGeneration: 4, pullRequestNumber: 123, sourceHead: "a".repeat(40), workerTerminationProven: true, nextAction: "Settle through the verified provider boundary." }, null, 2)}\n`,
  );
  return persistTransfer(
    directory,
    createNativeExecutionTransfer({
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
      runtime,
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
    }),
  );
}

test("native transfer binds exact bytes and rejects post-seal artifact drift", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-transfer-"),
  );
  const transfer = transferFixture(directory);
  assert.equal(
    verifyNativeExecutionTransfer(transfer, {
      directory,
      expected: {
        "producer.workflowRunId": 42,
        "producer.workflowRunAttempt": 3,
        "producer.job": "native-execution",
        "runtime.resolvedSha": RUNTIME_SHA,
        "runtime.selectionRoot": transfer.runtime.selectionRoot,
        "warrant.pullRequestNumber": 123,
      },
    }).transferRoot,
    transfer.transferRoot,
  );
  assert.throws(
    () =>
      verifyNativeExecutionTransfer(transfer, {
        directory,
        expected: { "producer.workflowRunAttempt": 4 },
      }),
    /producer\.workflowRunAttempt mismatch/u,
  );
  fs.appendFileSync(path.join(directory, "native-proof.json"), "drift\n");
  assert.throws(
    () => verifyNativeExecutionTransfer(transfer, { directory }),
    /transfer byte drift/u,
  );
});

test("credentialless seal binds fresh hosted context without provider jobs or callbacks", () => {
  const result = createNativeExecutionSealBinding({
    nativeContext: {
      schema: "kungfu.buildchain.native-job-context/v1",
      workflowRunId: 42,
      workflowRunAttempt: 3,
      job: "native-execution",
      runnerEnvironment: "github-hosted",
      runnerName: "GitHub Actions 1001",
      runnerOs: "Linux",
      runnerArch: "X64",
      outcome: "succeeded",
      evidenceCompletedAt: "2026-08-15T01:00:00Z",
    },
    sealJob: "seal-native-execution",
    sealRunnerName: "GitHub Actions 2002",
    sealRunnerEnvironment: "github-hosted",
    sealRunnerOs: "Linux",
    sealRunnerArch: "X64",
    observedAt: "2026-08-15T01:00:03Z",
  });
  assert.equal(result.producer.job, "native-execution");
  assert.equal(result.sealer.job, "seal-native-execution");
  assert.equal(Object.hasOwn(result.producer, "jobId"), false);
  assert.equal(Object.hasOwn(result.sealer, "jobId"), false);
});

test("runtime admission rejects exact SHAs and non-v4 selectors before transfer", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-runtime-admission-"),
  );
  const transfer = transferFixture(directory);
  for (const selector of ["v3", RUNTIME_SHA, "train/v4/v4.1/nope"]) {
    assert.throws(
      () =>
        createNativeExecutionTransfer({
          ...transfer,
          directory,
          files: transfer.files.map((entry) => entry.path),
          runtime: { ...transfer.runtime, selector },
        }),
      /runtime selector must be v4/u,
      selector,
    );
  }
  assert.throws(
    () =>
      verifyNativeExecutionTransfer(transfer, {
        directory,
        expected: { "runtime.resolvedSha": "e".repeat(40) },
      }),
    /runtime\.resolvedSha mismatch/u,
  );
});

test("missing, incomplete, and corrupt native transfers fail closed", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-transfer-corrupt-"),
  );
  const transfer = transferFixture(directory);
  const incomplete = rerootTransfer(transfer, (body) => body.files.pop());
  persistTransfer(directory, incomplete);
  assert.throws(
    () => verifyNativeExecutionTransfer(incomplete, { directory }),
    /required file set mismatch/u,
  );

  persistTransfer(directory, transfer);
  fs.rmSync(path.join(directory, "native-proof.json"));
  assert.throws(
    () => verifyNativeExecutionTransfer(transfer, { directory }),
    /membership mismatch|ENOENT|no such file/u,
  );
  fs.writeFileSync(path.join(directory, "native-proof.json"), "{corrupt\n");
  assert.throws(
    () => verifyNativeExecutionTransfer(transfer, { directory }),
    /transfer byte drift/u,
  );
});

test("recursive transfer membership rejects extras, links, directories, case collisions, and traversal", () => {
  for (const variant of ["extra", "directory", "symlink", "case-collision"]) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), `delivery-closed-${variant}-`),
    );
    const transfer = transferFixture(directory);
    if (variant === "extra")
      fs.writeFileSync(path.join(directory, "extra.json"), "{}\n");
    if (variant === "directory") fs.mkdirSync(path.join(directory, "nested"));
    if (variant === "symlink")
      fs.symlinkSync("warrant.json", path.join(directory, "linked.json"));
    if (variant === "case-collision")
      fs.writeFileSync(path.join(directory, "WARRANT.JSON"), "{}\n");
    assert.throws(
      () => verifyNativeExecutionTransfer(transfer, { directory }),
      /membership|symlink|case-colliding|non-regular|byte drift/u,
      variant,
    );
  }

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-traversal-"),
  );
  const transfer = transferFixture(directory);
  const traversal = rerootTransfer(transfer, (body) => {
    body.files[0].path = "../native-proof.json";
  });
  persistTransfer(directory, traversal);
  assert.throws(
    () => verifyNativeExecutionTransfer(traversal, { directory }),
    /archive-relative/u,
  );
});

test("dedicated staging copies only the declared closed set", () => {
  const source = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-stage-source-"),
  );
  const staging = path.join(
    os.tmpdir(),
    `delivery-stage-${crypto.randomUUID()}`,
  );
  const transfer = transferFixture(source);
  fs.writeFileSync(path.join(source, "candidate-extra.log"), "untrusted\n");
  stageNativeExecutionTransfer({
    sourceDirectory: source,
    stagingDirectory: staging,
    files: transfer.files.map((entry) => entry.path),
  });
  const staged = createNativeExecutionTransfer({
    directory: staging,
    files: transfer.files.map((entry) => entry.path),
    outcome: transfer.outcome,
    producer: transfer.producer,
    sealer: transfer.sealer,
    runtime: transfer.runtime,
    warrant: transfer.warrant,
    nativeProofRoot: transfer.nativeProofRoot,
    nativeReuseDecisionRoot: transfer.nativeReuseDecisionRoot,
    completedAt: transfer.completedAt,
    sealedAt: transfer.sealedAt,
  });
  persistTransfer(staging, staged);
  assert.equal(
    verifyNativeExecutionTransfer(staged, { directory: staging }).transferRoot,
    staged.transferRoot,
  );
  assert.equal(fs.existsSync(path.join(staging, "candidate-extra.log")), false);
});

test("failure verification recomputes canonical evidence and rejects mismatch, replay, and wrong transfer", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-failure-binding-"),
  );
  const sealed = failedTransferFixture(directory);
  const transfer = verifyNativeExecutionTransfer(sealed, { directory });
  const jobs = jobsFixture();
  jobs[0].conclusion = "failure";
  const boundary = createProviderFinalizerBoundary(
    boundaryFixture(transfer, { jobs }),
  );

  const failurePath = path.join(directory, "failure.json");
  const failure = JSON.parse(fs.readFileSync(failurePath, "utf8"));
  failure.reason = "rewritten failure";
  fs.writeFileSync(failurePath, `${JSON.stringify(failure, null, 2)}\n`);
  const mismatched = rerootTransfer(sealed, (body) => {
    body.files.find((entry) => entry.path === "failure.json").byteRoot =
      fileRoot(failurePath);
  });
  persistTransfer(directory, mismatched);
  assert.throws(
    () => verifyNativeExecutionTransfer(mismatched, { directory }),
    /failure evidence root drift/u,
  );

  assert.throws(
    () =>
      verifyProviderFailureSettlementBinding(boundary, transfer, {
        warrantStateRoot: ROOT("8"),
      }),
    /warrantStateRoot mismatch/u,
  );
  assert.throws(
    () =>
      verifyProviderFailureSettlementBinding(boundary, {
        ...transfer,
        transferRoot: ROOT("9"),
      }),
    /transfer root mismatch/u,
  );
  const rebound = structuredClone(boundary);
  delete rebound.boundaryRoot;
  rebound.failureSettlement.evidenceRoot = ROOT("8");
  rebound.boundaryRoot = devDeliveryContentRoot(rebound);
  assert.throws(
    () => verifyProviderFailureSettlementBinding(rebound, transfer),
    /boundary binding mismatch/u,
  );
});

test("failed native job carries a rooted transfer into independent settlement", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-transfer-failed-"),
  );
  const sealedTransfer = failedTransferFixture(directory);
  const transfer = verifyNativeExecutionTransfer(sealedTransfer, { directory });
  assert.equal(transfer.outcome, "failed");
  const jobs = jobsFixture();
  jobs[0].conclusion = "failure";
  const boundary = createProviderFinalizerBoundary(
    boundaryFixture(transfer, { jobs }),
  );
  assert.equal(boundary.nativeJob.conclusion, "failure");
  assert.equal(boundary.transferRoot, transfer.transferRoot);
  assert.equal(
    boundary.failureSettlement.evidenceRoot,
    transfer.failure.evidenceRoot,
  );
  assert.equal(
    verifyProviderFailureSettlementBinding(boundary, transfer)
      .finalizerBoundaryRoot,
    boundary.boundaryRoot,
  );
});

test("provider finalizer requires ordered distinct GitHub-hosted jobs and runners", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-boundary-"),
  );
  const transfer = transferFixture(directory);
  const boundary = createProviderFinalizerBoundary({
    ...boundaryFixture(transfer),
  });
  assert.equal(
    boundary.separation,
    "pairwise-distinct-github-hosted-native-seal-finalizer",
  );
  assert.match(boundary.boundaryRoot, /^sha256:[0-9a-f]{64}$/u);

  assert.throws(
    () =>
      createProviderFinalizerBoundary({
        ...boundaryFixture(transfer),
        jobs: jobsFixture("GitHub Actions 2002"),
        executionTransfer: {
          ...transfer,
          producer: {
            ...transfer.producer,
            runnerName: "GitHub Actions 2002",
          },
        },
      }),
    /pairwise distinct/u,
  );
  for (const index of [0, 1]) {
    const selfHosted = jobsFixture();
    selfHosted[index].labels.push("self-hosted");
    assert.throws(
      () =>
        createProviderFinalizerBoundary({
          ...boundaryFixture(transfer),
          jobs: selfHosted,
        }),
      /GitHub-hosted runner/u,
    );
  }
});

test("provider job ids and timestamps must prove strict finalizer ordering", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-boundary-order-"),
  );
  const transfer = transferFixture(directory);
  const sameIds = jobsFixture();
  sameIds[0].id = "502";
  assert.throws(
    () =>
      createProviderFinalizerBoundary(
        boundaryFixture(transfer, { jobs: sameIds }),
      ),
    /pairwise distinct/u,
  );

  const unordered = jobsFixture();
  unordered[1].started_at = unordered[0].completed_at;
  assert.throws(
    () =>
      createProviderFinalizerBoundary(
        boundaryFixture(transfer, { jobs: unordered }),
      ),
    /did not start after/u,
  );

  const invalidTimestamp = jobsFixture();
  invalidTimestamp[0].completed_at = "not-a-time";
  assert.throws(
    () =>
      createProviderFinalizerBoundary(
        boundaryFixture(transfer, { jobs: invalidTimestamp }),
      ),
    /ISO-8601 timestamp/u,
  );

  const wrongAttempt = jobsFixture();
  wrongAttempt[0].run_attempt = 2;
  assert.throws(
    () =>
      createProviderFinalizerBoundary(
        boundaryFixture(transfer, { jobs: wrongAttempt }),
      ),
    /run attempt mismatch/u,
  );
});

test("stale PR head or protected-base readback blocks the finalizer", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-boundary-source-"),
  );
  const transfer = transferFixture(directory);
  const stalePullRequest = providerSourceFixture();
  stalePullRequest.pullRequestReadback.head.sha = "c".repeat(40);
  assert.throws(
    () =>
      createProviderFinalizerBoundary(
        boundaryFixture(transfer, stalePullRequest),
      ),
    /pull request readback is stale/u,
  );

  const staleBase = providerSourceFixture();
  staleBase.baseRefReadback.ref = "refs/heads/dev/v4/v4.1";
  assert.throws(
    () => createProviderFinalizerBoundary(boundaryFixture(transfer, staleBase)),
    /protected base ref readback is stale/u,
  );
});

test("detached candidate with tracking unset cannot authorize a same-runner finalizer", () => {
  if (process.platform !== "linux") return;
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-detached-"),
  );
  const pidFile = path.join(directory, "observer.pid");
  const observationFile = path.join(directory, "observed.txt");
  const safeEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !isCredentialVariableName(name),
    ),
  );
  const command = [
    "unset RUNNER_TRACKING_ID",
    `setsid ${JSON.stringify(process.execPath)} ${JSON.stringify(OBSERVER)} ${JSON.stringify(pidFile)} ${JSON.stringify(observationFile)} >/dev/null 2>&1 &`,
    "disown || true",
    "exit 0",
  ].join("\n");
  const direct = spawnSync("bash", ["-lc", command], {
    encoding: "utf8",
    env: safeEnvironment,
  });
  assert.equal(direct.status, 0, direct.stderr);
  for (
    let attempt = 0;
    attempt < 100 && !fs.existsSync(pidFile);
    attempt += 1
  ) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.doesNotThrow(() => process.kill(pid, 0));

  const transfer = transferFixture(directory);
  assert.throws(
    () =>
      createProviderFinalizerBoundary({
        ...boundaryFixture(transfer),
        jobs: jobsFixture("GitHub Actions 2002"),
        executionTransfer: {
          ...transfer,
          producer: {
            ...transfer.producer,
            runnerName: "GitHub Actions 2002",
          },
        },
      }),
    /pairwise distinct/u,
  );
  process.kill(-pid, "SIGKILL");
  spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    env: { ...safeEnvironment, FINALIZER_AUTH_TOKEN: "sentinel-finalizer" },
  });
  assert.equal(fs.existsSync(observationFile), false);
});
