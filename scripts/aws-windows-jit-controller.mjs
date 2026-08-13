#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSyncCommand } from "../packages/core/spawn-command.js";
import {
  AWS_WINDOWS_JIT_CONTROLLER_CONTRACT,
  createWindowsJitLaunchPlan,
  windowsRunInstancesArgs,
} from "./aws-windows-jit-controller-core.mjs";
import {
  windowsCampaignMarkLaunchedArgs,
  windowsCampaignReservationItems,
} from "./aws-windows-jit-campaign-core.mjs";
import { renderWindowsJitBootstrap } from "./aws-windows-jit-core.mjs";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || "";
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function commandResult(command, args, options = {}) {
  const result = spawnSyncCommand(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
    env: process.env,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || result.error?.message || ""),
  };
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function jsonResult(result, label) {
  const output = requireSuccess(result, label);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function awsArgs(plan, profile, serviceArgs) {
  return [
    ...(profile ? ["--profile", profile] : []),
    "--region",
    plan.aws.region,
    ...serviceArgs,
  ];
}

function ghJson(args, input, label) {
  return jsonResult(commandResult("gh", args, { input }), label);
}

function assertLivePreflight(plan, profile) {
  const run = ghJson(
    ["api", `repos/${plan.repository}/actions/runs/${plan.github.runId}`],
    undefined,
    "GitHub run preflight",
  );
  if (
    run.event !== plan.github.event ||
    run.display_title !== plan.github.displayTitle ||
    run.head_sha !== plan.source.sha ||
    run.head_repository?.full_name !== plan.repository ||
    !["queued", "in_progress"].includes(run.status)
  ) {
    throw new Error("GitHub run is not the trusted exact-source dispatch");
  }
  const job = ghJson(
    ["api", `repos/${plan.repository}/actions/jobs/${plan.github.jobId}`],
    undefined,
    "GitHub job preflight",
  );
  if (job.status !== "queued") {
    throw new Error(
      `GitHub job must be queued, observed ${job.status || "unknown"}`,
    );
  }
  if (
    Array.isArray(job.labels) &&
    !plan.runner.labels.every((label) => job.labels.includes(label))
  ) {
    throw new Error("GitHub job labels do not match the JIT launch plan");
  }
  const active = jsonResult(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ec2",
        "describe-instances",
        "--filters",
        "Name=tag:kungfu:plane,Values=aws-us-elastic-runner-burst",
        "Name=tag:kungfu:provider,Values=windows-ec2-jit",
        "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down",
        "--output",
        "json",
      ]),
    ),
    "active Windows JIT instance preflight",
  );
  const activeInstances = (active.Reservations || []).flatMap(
    (reservation) => reservation.Instances || [],
  );
  if (activeInstances.length >= plan.safety.activeInstanceCeiling) {
    throw new Error("Windows JIT active instance ceiling is already reached");
  }
  const parameters = jsonResult(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ssm",
        "describe-parameters",
        "--parameter-filters",
        `Key=Name,Option=Equals,Values=${plan.aws.jitParameterName}`,
        "--output",
        "json",
      ]),
    ),
    "Windows JIT parameter preflight",
  );
  if ((parameters.Parameters || []).length !== 0) {
    throw new Error("Windows JIT parameter already exists");
  }
  const image = jsonResult(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ec2",
        "describe-images",
        "--image-ids",
        plan.aws.amiId,
        "--output",
        "json",
      ]),
    ),
    "Windows AMI preflight",
  ).Images?.[0];
  if (
    !image ||
    image.Name !== plan.aws.amiName ||
    image.Architecture !== "x86_64" ||
    image.State !== "available"
  ) {
    throw new Error("Windows AMI identity or availability mismatch");
  }
  return {
    budgetGuard: jsonResult(commandResult("bash", ["scripts/aws-windows-jit-operator.sh", "launch-gate", "--region", plan.aws.region, ...(profile ? ["--aws-profile", profile] : [])]), "provider Budget launch gate"),
    runStatus: run.status,
    jobStatus: job.status,
    activeInstances: activeInstances.length,
    amiOwnerId: image.OwnerId,
  };
}

function deleteRunnerRegistration(plan) {
  const runners = ghJson(
    ["api", `repos/${plan.repository}/actions/runners?per_page=100`],
    undefined,
    "GitHub runner cleanup lookup",
  ).runners;
  const runner = (runners || []).find(
    (entry) => entry.name === plan.runner.name,
  );
  if (!runner) return false;
  requireSuccess(
    commandResult("gh", [
      "api",
      "--method",
      "DELETE",
      `repos/${plan.repository}/actions/runners/${runner.id}`,
    ]),
    "GitHub runner cleanup",
  );
  return true;
}

function terminatePlanInstances(plan, profile) {
  const instances = jsonResult(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ec2",
        "describe-instances",
        "--filters",
        "Name=tag:kungfu:plane,Values=aws-us-elastic-runner-burst",
        "Name=tag:kungfu:provider,Values=windows-ec2-jit",
        `Name=tag:kungfu:github-run-id,Values=${plan.github.runId}`,
        `Name=tag:kungfu:github-run-attempt,Values=${plan.github.runAttempt}`,
        `Name=tag:kungfu:qualification-id,Values=${plan.github.qualificationId}`,
        `Name=tag:kungfu:source-sha,Values=${plan.source.sha}`,
        "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down",
        "--output",
        "json",
      ]),
    ),
    "failed-launch instance lookup",
  );
  const instanceIds = (instances.Reservations || [])
    .flatMap((reservation) => reservation.Instances || [])
    .map((instance) => instance.InstanceId)
    .filter((instanceId) => /^i-[0-9a-f]+$/.test(String(instanceId || "")));
  if (instanceIds.length === 0) return [];
  requireSuccess(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ec2",
        "terminate-instances",
        "--instance-ids",
        ...instanceIds,
        "--output",
        "json",
      ]),
    ),
    "failed-launch instance termination",
  );
  return instanceIds;
}

function cleanupFailedLaunch(
  plan,
  profile,
  { launchAttempted, parameterCreated },
) {
  const failures = [];
  const attempt = (cleanup) => {
    try {
      cleanup();
    } catch (error) {
      failures.push(error.message || String(error));
    }
  };
  if (launchAttempted) {
    attempt(() => terminatePlanInstances(plan, profile));
  }
  if (parameterCreated) {
    attempt(() =>
      requireSuccess(
        commandResult(
          "aws",
          awsArgs(plan, profile, [
            "ssm",
            "delete-parameter",
            "--name",
            plan.aws.jitParameterName,
          ]),
        ),
        "SSM JIT parameter cleanup",
      ),
    );
  }
  attempt(() => deleteRunnerRegistration(plan));
  return failures;
}

function generateJitConfiguration(plan) {
  const jit = ghJson(
    [
      "api",
      "--method",
      "POST",
      `repos/${plan.repository}/actions/runners/generate-jitconfig`,
      "--input",
      "-",
    ],
    JSON.stringify({
      name: plan.runner.name,
      runner_group_id: 1,
      labels: plan.runner.labels,
      work_folder: "_work",
    }),
    "GitHub JIT configuration",
  ).encoded_jit_config;
  if (!jit || typeof jit !== "string") {
    throw new Error("GitHub JIT configuration was empty");
  }
  return jit;
}

function createJitParameter(plan, profile, parameterInputPath, jit) {
  fs.writeFileSync(
    parameterInputPath,
    JSON.stringify({
      Name: plan.aws.jitParameterName,
      Description: `One-shot GitHub Actions JIT config for ${plan.repository} run ${plan.github.runId} attempt ${plan.github.runAttempt}`,
      Type: "SecureString",
      Tier: "Advanced",
      Value: jit,
      Tags: [
        { Key: "kungfu:owner", Value: "buildchain" },
        { Key: "kungfu:plane", Value: "aws-us-elastic-runner-burst" },
        { Key: "kungfu:provider", Value: "windows-ec2-jit" },
        { Key: "kungfu:campaign-id", Value: plan.campaign.id },
        { Key: "kungfu:github-run-id", Value: plan.github.runId },
        {
          Key: "kungfu:qualification-id",
          Value: plan.github.qualificationId,
        },
      ],
    }),
    { mode: 0o600 },
  );
  requireSuccess(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ssm",
        "put-parameter",
        "--cli-input-json",
        `file://${parameterInputPath}`,
        "--output",
        "json",
      ]),
    ),
    "SSM JIT parameter creation",
  );
}

function writeBootstrap(plan, bootstrapPath) {
  const template = fs.readFileSync(
    path.resolve(
      "infra/aws-us-elastic-runner-burst-plane/windows-jit-bootstrap.ps1",
    ),
    "utf8",
  );
  fs.writeFileSync(
    bootstrapPath,
    renderWindowsJitBootstrap(template, {
      region: plan.aws.region,
      campaignId: plan.campaign.id,
      jitParameterName: plan.aws.jitParameterName,
      evidenceBucket: plan.aws.evidenceBucket,
      runnerLabel: plan.runner.label,
      sourceSha: plan.source.sha,
      githubRunId: plan.github.runId,
      githubRunAttempt: plan.github.runAttempt,
      amiId: plan.aws.amiId,
      amiName: plan.aws.amiName,
      instanceType: plan.aws.instanceType,
      launchedAt: plan.aws.launchedAt,
    }),
    { mode: 0o600 },
  );
}

function assertLaunchDryRun(plan, profile, bootstrapPath) {
  const dryRun = commandResult(
    "aws",
    awsArgs(
      plan,
      profile,
      windowsRunInstancesArgs(plan, { bootstrapPath, dryRun: true }),
    ),
  );
  if (
    dryRun.status === 0 ||
    !/DryRunOperation/.test(`${dryRun.stdout}\n${dryRun.stderr}`)
  ) {
    throw new Error("EC2 RunInstances DryRun did not return DryRunOperation");
  }
}

function reserveCampaign(plan, profile) {
  requireSuccess(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "dynamodb",
        "transact-write-items",
        "--transact-items",
        JSON.stringify(
          windowsCampaignReservationItems(plan, new Date().toISOString()),
        ),
        "--output",
        "json",
      ]),
    ),
    "Windows campaign atomic reservation",
  );
}

function launchInstance(plan, profile, bootstrapPath) {
  const launched = jsonResult(
    commandResult(
      "aws",
      awsArgs(
        plan,
        profile,
        windowsRunInstancesArgs(plan, { bootstrapPath, dryRun: false }),
      ),
    ),
    "EC2 RunInstances",
  );
  const instance = launched.Instances?.[0];
  if (!/^i-[0-9a-f]+$/.test(String(instance?.InstanceId || ""))) {
    throw new Error("EC2 RunInstances returned no instance identity");
  }
  return instance;
}

function markCampaignLaunched(plan, profile, instanceId) {
  requireSuccess(
    commandResult(
      "aws",
      awsArgs(
        plan,
        profile,
        windowsCampaignMarkLaunchedArgs(
          plan,
          instanceId,
          new Date().toISOString(),
        ),
      ),
    ),
    "Windows campaign launch ledger update",
  );
}

export function executeWindowsJitLaunch(plan, { profile = "" } = {}) {
  if (plan?.contract !== AWS_WINDOWS_JIT_CONTROLLER_CONTRACT) {
    throw new Error("Windows JIT launch plan contract is invalid");
  }
  const preflight = assertLivePreflight(plan, profile);
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-windows-jit-controller-"),
  );
  fs.chmodSync(tempRoot, 0o700);
  const parameterInputPath = path.join(tempRoot, "ssm-input.json");
  const bootstrapPath = path.join(tempRoot, "bootstrap.ps1");
  let parameterCreated = false;
  let launchAttempted = false;
  let launchSucceeded = false;
  let result;
  let failure;
  const cleanupFailures = [];
  try {
    const jit = generateJitConfiguration(plan);
    createJitParameter(plan, profile, parameterInputPath, jit);
    parameterCreated = true;
    writeBootstrap(plan, bootstrapPath);
    assertLaunchDryRun(plan, profile, bootstrapPath);
    reserveCampaign(plan, profile);
    launchAttempted = true;
    const instance = launchInstance(plan, profile, bootstrapPath);
    launchSucceeded = true;
    markCampaignLaunched(plan, profile, instance.InstanceId);
    result = {
      schemaVersion: 1,
      contract: AWS_WINDOWS_JIT_CONTROLLER_CONTRACT,
      kind: "launch-result",
      status: "launched",
      source: plan.source,
      campaign: plan.campaign,
      github: plan.github,
      runner: plan.runner,
      aws: {
        region: plan.aws.region,
        instanceId: instance.InstanceId,
        imageId: instance.ImageId,
        instanceType: instance.InstanceType,
        launchTime: instance.LaunchTime,
        jitParameterName: plan.aws.jitParameterName,
      },
      preflight,
      dryRun: "DryRunOperation",
      planDigest: plan.digest,
    };
  } catch (error) {
    failure = error;
  } finally {
    if (!launchSucceeded) {
      cleanupFailures.push(
        ...cleanupFailedLaunch(plan, profile, {
          launchAttempted,
          parameterCreated,
        }),
      );
    }
    for (const file of [parameterInputPath, bootstrapPath]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(tempRoot);
  }
  if (failure) {
    if (cleanupFailures.length > 0) {
      throw new Error(
        `${failure.message || failure}; cleanup failed: ${cleanupFailures.join("; ")}`,
      );
    }
    throw failure;
  }
  return result;
}

function planFromArgs(execute) {
  return createWindowsJitLaunchPlan({
    execute,
    repository: arg("repository", "kungfu-systems/kungfu"),
    runId: arg("run-id"),
    runAttempt: arg("run-attempt", "1"),
    jobId: arg("job-id"),
    qualificationId: arg("qualification-id"),
    campaignId: arg("campaign-id"),
    runnerLabel: arg("runner-label"),
    runnerName: arg("runner-name"),
    sourceSha: arg("source-sha"),
    sourceRef: arg("source-ref"),
    region: arg("region", "us-east-1"),
    instanceType: arg("instance-type", "c7i.4xlarge"),
    amiId: arg("ami-id"),
    amiName: arg("ami-name"),
    subnetId: arg("subnet-id"),
    securityGroupId: arg("security-group-id"),
    instanceProfileName: arg("instance-profile-name"),
    evidenceBucket: arg("evidence-bucket"),
    stateTable: arg("state-table"),
    jitParameterName: arg("jit-parameter"),
    launchedAt: arg("launched-at", new Date().toISOString()),
  });
}

export function main() {
  const execute = flag("execute");
  const plan = planFromArgs(execute);
  if (!execute) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  }
  if (arg("confirm-source-sha") !== plan.source.sha) {
    throw new Error("--confirm-source-sha must equal the exact source SHA");
  }
  if (arg("confirm-run-id") !== plan.github.runId) {
    throw new Error("--confirm-run-id must equal the exact GitHub run id");
  }
  if (arg("confirm-campaign-id") !== plan.campaign.id) {
    throw new Error("--confirm-campaign-id must equal the campaign id");
  }
  if (arg("confirm-state-table") !== plan.aws.stateTable) {
    throw new Error("--confirm-state-table must equal the campaign state table");
  }
  const result = executeWindowsJitLaunch(plan, {
    profile: arg("aws-profile"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message || error}`);
    process.exitCode = 1;
  }
}
