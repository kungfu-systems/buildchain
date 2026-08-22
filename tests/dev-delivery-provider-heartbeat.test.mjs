import assert from "node:assert/strict";
import test from "node:test";

import { devDeliveryContentRoot } from "../packages/core/dev-delivery-warrant.js";
import {
  runDevDeliveryProviderHeartbeat,
  verifyDevDeliveryProviderHeartbeat,
} from "../packages/core/dev-delivery-provider-heartbeat.js";
import { coordinateExactProviderAttemptAfterHeartbeatLoss } from "../scripts/dev-delivery-provider-heartbeat.mjs";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;

function admission() {
  return {
    observation: {
      repository: "kungfu-systems/buildchain",
      protectedBase: "dev/v4/v4.0",
      stateRoot: ROOT("1"),
      activeWarrant: {
        candidateId: ROOT("2"),
        fencingToken: ROOT("3"),
        generation: 4,
        issuedAt: "2026-08-15T00:00:00.000Z",
        heartbeatAt: "2026-08-15T00:00:00.000Z",
        expiresAt: "2026-08-15T00:01:00.000Z",
      },
    },
  };
}

function jobs(completed, callerPath = "") {
  const providerName = (name) =>
    callerPath ? `${callerPath} / ${name}` : name;
  return {
    jobs: [
      {
        id: 10,
        name: providerName("Reserve exact delivery candidate"),
        status: "completed",
        conclusion: "success",
        runner_name: "GitHub Actions 10",
        runner_group_name: "GitHub Actions",
        labels: ["ubuntu-24.04", "X64"],
        started_at: "2026-08-15T00:00:00.000Z",
        completed_at: "2026-08-15T00:00:05.000Z",
      },
      {
        id: 11,
        name: providerName("Credentialless native execution"),
        status: completed ? "completed" : "in_progress",
        conclusion: completed ? "success" : null,
        runner_name: "GitHub Actions 11",
        runner_group_name: "GitHub Actions",
        labels: ["ubuntu-24.04", "X64"],
        started_at: "2026-08-15T00:00:00.000Z",
        completed_at: completed ? "2026-08-15T00:00:20.000Z" : null,
      },
      {
        id: 12,
        name: providerName("Credentialless native evidence seal"),
        status: completed ? "completed" : "queued",
        conclusion: completed ? "success" : null,
        runner_name: completed ? "GitHub Actions 12" : "",
        runner_group_name: completed ? "GitHub Actions" : "",
        labels: completed ? ["X64", "ubuntu-24.04"] : [],
        started_at: completed ? "2026-08-15T00:00:21.000Z" : null,
        completed_at: completed ? "2026-08-15T00:00:25.000Z" : null,
      },
      {
        id: 13,
        name: providerName("Credentialed independent Warrant heartbeat"),
        status: completed ? "completed" : "in_progress",
        conclusion: completed ? "success" : null,
        runner_name: "GitHub Actions 13",
        runner_group_name: "GitHub Actions",
        labels: ["macos-15", "ARM64"],
        started_at: "2026-08-15T00:00:01.000Z",
        completed_at: completed ? "2026-08-15T00:00:26.000Z" : null,
      },
      {
        id: 14,
        name: providerName("Credentialed provider finalizer"),
        status: "in_progress",
        conclusion: null,
        runner_name: "GitHub Actions 14",
        runner_group_name: "GitHub Actions",
        labels: ["ubuntu-24.04", "X64"],
        started_at: "2026-08-15T00:00:27.000Z",
        completed_at: null,
      },
    ],
  };
}

test("public reusable caller job names drive heartbeat execution and final verification", async () => {
  let stateRoot = ROOT("1");
  let beat = 0;
  let currentTime = 0;
  const result = await runDevDeliveryProviderHeartbeat(
    {
      admission: admission(),
      workflowRunId: 90,
      workflowRunAttempt: 2,
      leaseSeconds: 60,
      heartbeatSeconds: 10,
    },
    {
      now: () =>
        new Date(
          Date.parse("2026-08-15T00:00:01.000Z") + currentTime,
        ).toISOString(),
      wait: async (milliseconds) => {
        currentTime += milliseconds;
      },
      heartbeat: async ({ expectedOldStateRoot }) => {
        assert.equal(expectedOldStateRoot, stateRoot);
        beat += 1;
        const nextStateRoot = ROOT((beat + 3).toString(16));
        const heartbeatAt = new Date(
          Date.parse("2026-08-15T00:00:01.000Z") + currentTime,
        ).toISOString();
        const receipt = {
          schema: "kungfu.buildchain.dev-delivery-lease-receipt/v1",
          action: "heartbeat",
          candidateId: ROOT("2"),
          fencingToken: ROOT("3"),
          leaseGeneration: 4,
          expiresAt: new Date(Date.parse(heartbeatAt) + 60_000).toISOString(),
          expectedOldStateRoot,
          nextStateRoot,
          nextAction: "Continue the exact fenced delivery attempt.",
        };
        stateRoot = nextStateRoot;
        return {
          before: { stateRoot: expectedOldStateRoot },
          after: { stateRoot: nextStateRoot },
          receipt,
          receiptRoot: devDeliveryContentRoot(receipt),
          observation: {
            stateRoot: nextStateRoot,
            activeWarrant: {
              candidateId: ROOT("2"),
              fencingToken: ROOT("3"),
              generation: 4,
              heartbeatAt,
              expiresAt: receipt.expiresAt,
            },
          },
        };
      },
      readJobs: async () => jobs(beat > 6, "deliver"),
    },
  );
  assert.equal(result.heartbeatCount, 7);
  assert.equal(result.latestStateRoot, ROOT("a"));
  assert.ok(
    Date.parse(result.latestHeartbeatAt) >
      Date.parse(admission().observation.activeWarrant.expiresAt),
  );
  assert.equal(result.nativeJob.status, "completed");
  assert.equal(result.sealJob.status, "completed");
  assert.equal(
    verifyDevDeliveryProviderHeartbeat(result, {
      admission: admission(),
      jobsReadback: jobs(true, "deliver"),
      liveObservation: {
        stateRoot: ROOT("a"),
        activeWarrant: { fencingToken: ROOT("3"), generation: 4 },
      },
      workflowRunId: 90,
      workflowRunAttempt: 2,
      observedAt: "2026-08-15T00:01:10.000Z",
    }).ok,
    true,
  );

  const similar = jobs(true, "deliver");
  similar.jobs[1].name = "deliver / Credentialless native execution replay";
  assert.throws(
    () =>
      verifyDevDeliveryProviderHeartbeat(result, {
        admission: admission(),
        jobsReadback: similar,
        liveObservation: {
          stateRoot: ROOT("a"),
          activeWarrant: { fencingToken: ROOT("3"), generation: 4 },
        },
        workflowRunId: 90,
        workflowRunAttempt: 2,
        observedAt: "2026-08-15T00:01:10.000Z",
      }),
    /exactly one provider job named Credentialless native execution/u,
  );

  const ambiguous = jobs(true, "deliver");
  ambiguous.jobs.push({
    ...ambiguous.jobs[1],
    id: 99,
    name: "public-caller / Credentialless native execution",
  });
  assert.throws(
    () =>
      verifyDevDeliveryProviderHeartbeat(result, {
        admission: admission(),
        jobsReadback: ambiguous,
        liveObservation: {
          stateRoot: ROOT("a"),
          activeWarrant: { fencingToken: ROOT("3"), generation: 4 },
        },
        workflowRunId: 90,
        workflowRunAttempt: 2,
        observedAt: "2026-08-15T00:01:10.000Z",
      }),
    /exactly one provider job named Credentialless native execution/u,
  );
});

test("provider heartbeat keeps the fence live until the seal job materializes", async () => {
  let stateRoot = ROOT("1");
  let beat = 0;
  let currentTime = 0;
  const result = await runDevDeliveryProviderHeartbeat(
    {
      admission: admission(),
      workflowRunId: 90,
      workflowRunAttempt: 2,
      leaseSeconds: 60,
      heartbeatSeconds: 10,
    },
    {
      now: () =>
        new Date(
          Date.parse("2026-08-15T00:00:01.000Z") + currentTime,
        ).toISOString(),
      wait: async (milliseconds) => {
        currentTime += milliseconds;
      },
      heartbeat: async ({ expectedOldStateRoot }) => {
        assert.equal(expectedOldStateRoot, stateRoot);
        beat += 1;
        const nextStateRoot = ROOT((beat + 3).toString(16));
        const heartbeatAt = new Date(
          Date.parse("2026-08-15T00:00:01.000Z") + currentTime,
        ).toISOString();
        const receipt = {
          schema: "kungfu.buildchain.dev-delivery-lease-receipt/v1",
          action: "heartbeat",
          candidateId: ROOT("2"),
          fencingToken: ROOT("3"),
          leaseGeneration: 4,
          expiresAt: new Date(Date.parse(heartbeatAt) + 60_000).toISOString(),
          expectedOldStateRoot,
          nextStateRoot,
          nextAction: "Continue the exact fenced delivery attempt.",
        };
        stateRoot = nextStateRoot;
        return {
          before: { stateRoot: expectedOldStateRoot },
          after: { stateRoot: nextStateRoot },
          receipt,
          receiptRoot: devDeliveryContentRoot(receipt),
          observation: {
            stateRoot: nextStateRoot,
            activeWarrant: {
              candidateId: ROOT("2"),
              fencingToken: ROOT("3"),
              generation: 4,
              heartbeatAt,
              expiresAt: receipt.expiresAt,
            },
          },
        };
      },
      readJobs: async () => {
        const readback = jobs(true);
        if (beat === 1) {
          readback.jobs = readback.jobs.filter(
            ({ name }) => name !== "Credentialless native evidence seal",
          );
        }
        return readback;
      },
    },
  );
  assert.equal(result.heartbeatCount, 2);
  assert.equal(result.latestStateRoot, ROOT("5"));
  assert.equal(result.sealJob.status, "completed");
});

test("heartbeat execution rejects similar and ambiguous reusable caller job names", async () => {
  for (const variant of ["similar", "ambiguous"]) {
    const readback = jobs(true, "deliver");
    if (variant === "similar") {
      readback.jobs[1].name =
        "deliver / Credentialless native execution replay";
    } else {
      readback.jobs.push({
        ...readback.jobs[1],
        id: 99,
        name: "other-caller / Credentialless native execution",
      });
    }
    await assert.rejects(
      runDevDeliveryProviderHeartbeat(
        {
          admission: admission(),
          workflowRunId: 90,
          workflowRunAttempt: 2,
          leaseSeconds: 60,
          heartbeatSeconds: 10,
        },
        {
          now: () => "2026-08-15T00:00:01.000Z",
          heartbeat: async ({ expectedOldStateRoot }) => {
            const receipt = {
              schema: "kungfu.buildchain.dev-delivery-lease-receipt/v1",
              action: "heartbeat",
              candidateId: ROOT("2"),
              fencingToken: ROOT("3"),
              leaseGeneration: 4,
              expiresAt: "2026-08-15T00:01:01.000Z",
              expectedOldStateRoot,
              nextStateRoot: ROOT("4"),
              nextAction: "Continue the exact fenced delivery attempt.",
            };
            return {
              before: { stateRoot: expectedOldStateRoot },
              after: { stateRoot: ROOT("4") },
              receipt,
              receiptRoot: devDeliveryContentRoot(receipt),
              observation: {
                stateRoot: ROOT("4"),
                activeWarrant: {
                  fencingToken: ROOT("3"),
                  generation: 4,
                  heartbeatAt: "2026-08-15T00:00:01.000Z",
                  expiresAt: receipt.expiresAt,
                },
              },
            };
          },
          readJobs: async () => readback,
        },
      ),
      /exactly one provider job named Credentialless native execution/u,
      variant,
    );
  }
});

test("heartbeat execution uses the canonical mutation Warrant when public observation omits heartbeat time", async () => {
  const result = await runDevDeliveryProviderHeartbeat(
    {
      admission: admission(),
      workflowRunId: 90,
      workflowRunAttempt: 2,
      leaseSeconds: 60,
      heartbeatSeconds: 10,
    },
    {
      now: () => "2026-08-15T00:00:01.000Z",
      heartbeat: async ({ expectedOldStateRoot }) => {
        const heartbeatAt = "2026-08-15T00:00:01.000Z";
        const expiresAt = "2026-08-15T00:01:01.000Z";
        const receipt = {
          schema: "kungfu.buildchain.dev-delivery-lease-receipt/v1",
          action: "heartbeat",
          candidateId: ROOT("2"),
          fencingToken: ROOT("3"),
          leaseGeneration: 4,
          expiresAt,
          expectedOldStateRoot,
          nextStateRoot: ROOT("4"),
          nextAction: "Continue the exact fenced delivery attempt.",
        };
        return {
          before: { stateRoot: expectedOldStateRoot },
          after: { stateRoot: ROOT("4") },
          receipt,
          receiptRoot: devDeliveryContentRoot(receipt),
          warrant: {
            candidateId: ROOT("2"),
            fencingToken: ROOT("3"),
            generation: 4,
            heartbeatAt,
            expiresAt,
          },
          observation: {
            stateRoot: ROOT("4"),
            activeWarrant: {
              candidateId: ROOT("2"),
              fencingToken: ROOT("3"),
              generation: 4,
              expiresAt,
            },
          },
        };
      },
      readJobs: async () => jobs(true),
    },
  );
  assert.equal(result.latestHeartbeatAt, "2026-08-15T00:00:01.000Z");
});

test("finalizer fails closed on missing continuity, stale state, or job drift", async () => {
  const base = await runDevDeliveryProviderHeartbeat(
    {
      admission: admission(),
      workflowRunId: 90,
      workflowRunAttempt: 2,
      leaseSeconds: 60,
      heartbeatSeconds: 10,
    },
    {
      now: () => "2026-08-15T00:00:01.000Z",
      heartbeat: async ({ expectedOldStateRoot }) => {
        const receipt = {
          schema: "kungfu.buildchain.dev-delivery-lease-receipt/v1",
          action: "heartbeat",
          candidateId: ROOT("2"),
          fencingToken: ROOT("3"),
          leaseGeneration: 4,
          expiresAt: "2026-08-15T00:01:01.000Z",
          expectedOldStateRoot,
          nextStateRoot: ROOT("4"),
          nextAction: "Continue the exact fenced delivery attempt.",
        };
        return {
          before: { stateRoot: expectedOldStateRoot },
          after: { stateRoot: ROOT("4") },
          receipt,
          receiptRoot: devDeliveryContentRoot(receipt),
          observation: {
            stateRoot: ROOT("4"),
            activeWarrant: {
              fencingToken: ROOT("3"),
              generation: 4,
              heartbeatAt: "2026-08-15T00:00:01.000Z",
              expiresAt: "2026-08-15T00:01:01.000Z",
            },
          },
        };
      },
      readJobs: async () => jobs(true),
    },
  );
  const options = {
    admission: admission(),
    jobsReadback: jobs(true),
    liveObservation: {
      stateRoot: ROOT("4"),
      activeWarrant: { fencingToken: ROOT("3"), generation: 4 },
    },
    workflowRunId: 90,
    workflowRunAttempt: 2,
    observedAt: "2026-08-15T00:00:20.000Z",
  };
  const missing = { ...base, heartbeats: [], heartbeatCount: 0 };
  delete missing.receiptRoot;
  missing.receiptRoot = devDeliveryContentRoot(missing);
  assert.throws(
    () => verifyDevDeliveryProviderHeartbeat(missing, options),
    /continuity is missing/u,
  );
  assert.throws(
    () =>
      verifyDevDeliveryProviderHeartbeat(base, {
        ...options,
        liveObservation: {
          ...options.liveObservation,
          stateRoot: ROOT("6"),
        },
      }),
    /latest durable state mismatch/u,
  );
  const driftedJobs = jobs(true);
  driftedJobs.jobs[1].id = 99;
  assert.throws(
    () =>
      verifyDevDeliveryProviderHeartbeat(base, {
        ...options,
        jobsReadback: driftedJobs,
      }),
    /terminal jobs readback mismatch/u,
  );
  const reusedHeartbeatRunner = jobs(true);
  reusedHeartbeatRunner.jobs[3].runner_name =
    reusedHeartbeatRunner.jobs[0].runner_name;
  reusedHeartbeatRunner.jobs[3].labels = ["ubuntu-24.04", "X64"];
  assert.throws(
    () =>
      verifyDevDeliveryProviderHeartbeat(base, {
        ...options,
        jobsReadback: reusedHeartbeatRunner,
      }),
    /heartbeat runner domain is not independent/u,
  );
  const selfHostedHeartbeat = jobs(true);
  selfHostedHeartbeat.jobs[3].runner_group_name = "Default";
  selfHostedHeartbeat.jobs[3].labels = ["self-hosted", "macOS", "ARM64"];
  assert.throws(
    () =>
      verifyDevDeliveryProviderHeartbeat(base, {
        ...options,
        jobsReadback: selfHostedHeartbeat,
      }),
    /requires the GitHub-hosted runner group/u,
  );
});

test("provider heartbeat loss invokes exact-attempt fail-closed coordination", async () => {
  const losses = [];
  await assert.rejects(
    runDevDeliveryProviderHeartbeat(
      {
        admission: admission(),
        workflowRunId: 90,
        workflowRunAttempt: 2,
        leaseSeconds: 60,
        heartbeatSeconds: 10,
      },
      {
        heartbeat: async () => {
          throw new Error("stale fencing token");
        },
        readJobs: async () => jobs(false),
        onHeartbeatLoss: async (loss) => losses.push(loss),
      },
    ),
    /stale fencing token/u,
  );
  assert.equal(losses.length, 1);
  assert.equal(losses[0].workflowRunId, 90);
  assert.equal(losses[0].workflowRunAttempt, 2);
  assert.equal(losses[0].fencingToken, ROOT("3"));
  assert.equal(losses[0].leaseGeneration, 4);
});

test("heartbeat-loss coordinator never uses the run-scoped cancellation API", async () => {
  const cancelled = [];
  const adapters = {
    readRun: async () => ({
      id: 90,
      run_attempt: 2,
      repository: { full_name: "kungfu-systems/buildchain" },
      status: "in_progress",
    }),
    cancelRun: async (runId) => cancelled.push(runId),
  };
  const coordinated = await coordinateExactProviderAttemptAfterHeartbeatLoss(
    {
      repository: "kungfu-systems/buildchain",
      workflowRunId: 90,
      workflowRunAttempt: 2,
    },
    adapters,
  );
  assert.equal(coordinated.workflowRunAttempt, 2);
  assert.equal(coordinated.cancellation, "withheld-run-scoped-api");
  assert.deepEqual(cancelled, []);
  await assert.rejects(
    coordinateExactProviderAttemptAfterHeartbeatLoss(
      {
        repository: "kungfu-systems/buildchain",
        workflowRunId: 90,
        workflowRunAttempt: 1,
      },
      adapters,
    ),
    /cannot coordinate a different provider attempt/u,
  );
  assert.deepEqual(cancelled, []);
});
