// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

export function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
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

export function requireSuccess(result, label) {
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

export function jsonResult(result, label) {
  const output = requireSuccess(result, label);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export function awsArgs(plan, profile, serviceArgs) {
  return [
    ...(profile ? ["--profile", profile] : []),
    "--region",
    plan.aws.region,
    ...serviceArgs,
  ];
}

export function awsJson(plan, profile, serviceArgs, label) {
  return jsonResult(
    commandResult("aws", awsArgs(plan, profile, serviceArgs)),
    label,
  );
}

export function ghJson(args, input, label) {
  return jsonResult(commandResult("gh", args, { input }), label);
}

export function assertOwnership(resourceTags, plan) {
  const observed = Object.fromEntries(
    (resourceTags || []).map((entry) => [entry.Key, String(entry.Value)]),
  );
  const expected = {
    "kungfu:owner": "buildchain",
    "kungfu:plane": "aws-us-elastic-runner-burst",
    "kungfu:provider": "macos-ec2-jit",
    "kungfu:campaign-id": plan.campaign.id,
    "kungfu:source-sha": plan.source.sha,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (observed[key] !== value) {
      throw new Error(`AWS resource ownership tag ${key} mismatch`);
    }
  }
}

export function assertDryRun(result, label) {
  if (
    result.status === 0 ||
    !/DryRunOperation/.test(`${result.stdout}\n${result.stderr}`)
  ) {
    throw new Error(`${label} did not return DryRunOperation`);
  }
}
