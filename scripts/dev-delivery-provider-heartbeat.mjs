#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  runDevDeliveryProviderHeartbeat,
  verifyDevDeliveryProviderHeartbeat,
} from "../packages/core/dev-delivery-provider-heartbeat.js";
import { runDevDeliveryCommand } from "./dev-delivery-warrant.mjs";

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function readJson(file, label) {
  if (!file) throw new Error(`${label} is required`);
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`);
}

async function githubJson(apiUrl, token, requestPath, method = "GET") {
  if (!token) throw new Error("provider heartbeat requires GitHub credentials");
  const response = await fetch(
    `${String(apiUrl).replace(/\/$/u, "")}${requestPath}`,
    {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  const bytes = await response.text();
  const body = bytes ? JSON.parse(bytes) : {};
  if (!response.ok) {
    throw new Error(
      `GitHub provider ${requestPath} failed with ${response.status}: ${body.message || "unknown error"}`,
    );
  }
  return body;
}

function repositoryParts(value) {
  const match = String(value || "").match(/^([^/\s]+)\/([^/\s]+)$/u);
  if (!match) throw new Error("repository must be owner/repo");
  return { owner: match[1], repo: match[2] };
}

export async function coordinateExactProviderAttemptAfterHeartbeatLoss(
  { repository, workflowRunId, workflowRunAttempt },
  { readRun },
) {
  const run = await readRun(workflowRunId);
  if (
    Number(run.id) !== workflowRunId ||
    Number(run.run_attempt) !== workflowRunAttempt ||
    run.repository?.full_name !== repository ||
    run.status !== "in_progress"
  ) {
    throw new Error(
      "heartbeat loss cannot coordinate a different provider attempt",
    );
  }
  return {
    action: "exact-attempt-heartbeat-loss-observed",
    workflowRunId,
    workflowRunAttempt,
    cancellation: "withheld-run-scoped-api",
    nextAction:
      "Wait for terminal readback of this exact attempt; never cancel the run-scoped coordinate.",
  };
}

export async function runProviderHeartbeatCommand(options) {
  const { owner, repo } = repositoryParts(options.repository);
  return runDevDeliveryProviderHeartbeat(
    {
      admission: options.admission,
      workflowRunId: options.workflowRunId,
      workflowRunAttempt: options.workflowRunAttempt,
      leaseSeconds: options.leaseSeconds,
      heartbeatSeconds: options.heartbeatSeconds,
    },
    {
      heartbeat: ({
        expectedOldStateRoot,
        fencingToken,
        leaseGeneration,
        leaseSeconds,
      }) =>
        runDevDeliveryCommand({
          command: "heartbeat",
          repository: options.repository,
          branch: options.branch,
          expectedOldStateRoot,
          fencingToken,
          leaseGeneration,
          leaseSeconds,
          execute: true,
          token: options.token,
          apiUrl: options.apiUrl,
        }),
      readJobs: () =>
        githubJson(
          options.apiUrl,
          options.token,
          `/repos/${owner}/${repo}/actions/runs/${options.workflowRunId}/attempts/${options.workflowRunAttempt}/jobs?per_page=100`,
        ),
      onHeartbeatLoss:
        options.onHeartbeatLoss ||
        (async ({ workflowRunId, workflowRunAttempt }) => {
          await coordinateExactProviderAttemptAfterHeartbeatLoss(
            {
              repository: options.repository,
              workflowRunId,
              workflowRunAttempt,
            },
            {
              readRun: (runId) =>
                githubJson(
                  options.apiUrl,
                  options.token,
                  `/repos/${owner}/${repo}/actions/runs/${runId}`,
                ),
            },
          );
        }),
    },
  );
}

export async function verifyProviderHeartbeatCommand(options) {
  const observed = await runDevDeliveryCommand({
    command: "observe",
    repository: options.repository,
    branch: options.branch,
    token: options.token,
    apiUrl: options.apiUrl,
  });
  return verifyDevDeliveryProviderHeartbeat(options.receipt, {
    admission: options.admission,
    jobsReadback: options.jobsReadback,
    liveObservation: observed.observation,
    workflowRunId: options.workflowRunId,
    workflowRunAttempt: options.workflowRunAttempt,
    admissionJobName: options.admissionJobName,
    heartbeatJobName: options.heartbeatJobName,
    finalizerJobName: options.finalizerJobName,
    observedAt: options.now,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "";
  if (!new Set(["run", "verify"]).has(command)) {
    process.stdout.write(
      "Usage: dev-delivery-provider-heartbeat.mjs <run|verify> --admission FILE --repository owner/repo --branch dev/vN/vN.M --workflow-run-id N --workflow-run-attempt N --output FILE\n",
    );
    return;
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const common = {
    repository: flag(args, "repository", process.env.GITHUB_REPOSITORY),
    branch: flag(args, "branch", process.env.GITHUB_BASE_REF),
    admission: readJson(flag(args, "admission"), "admission"),
    workflowRunId: Number(process.env.GITHUB_RUN_ID),
    workflowRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    token,
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    now: new Date().toISOString(),
    admissionJobName: flag(
      args,
      "admission-job-name",
      "Reserve exact delivery candidate",
    ),
    heartbeatJobName: flag(
      args,
      "heartbeat-job-name",
      "Credentialed independent Warrant heartbeat",
    ),
    finalizerJobName: flag(
      args,
      "finalizer-job-name",
      "Credentialed provider finalizer",
    ),
  };
  const result =
    command === "run"
      ? await runProviderHeartbeatCommand({
          ...common,
          leaseSeconds: Number(flag(args, "lease-seconds", "3600")),
          heartbeatSeconds: Number(flag(args, "heartbeat-seconds", "30")),
        })
      : await verifyProviderHeartbeatCommand({
          ...common,
          receipt: readJson(flag(args, "receipt"), "heartbeat receipt"),
          jobsReadback: readJson(flag(args, "jobs-readback"), "jobs readback"),
        });
  writeJson(flag(args, "output"), result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`dev delivery provider heartbeat: ${error.message}`);
    process.exit(1);
  });
}
