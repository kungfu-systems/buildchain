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

export function assertAllowedPolicySimulation(
  plan,
  profile,
  principalArn,
  actionName,
) {
  if (!/^arn:aws:iam::\d{12}:(?:user|role)\/.+/.test(principalArn || "")) {
    throw new Error(
      "AWS allocation policy simulation requires an IAM user or role principal ARN",
    );
  }
  const contextEntries = [
    `ContextKeyName=aws:RequestedRegion,ContextKeyValues=${plan.aws.region},ContextKeyType=string`,
    ...plan.aws.hostTags.map(
      ({ Key, Value }) =>
        `ContextKeyName=aws:RequestTag/${Key},ContextKeyValues=${Value},ContextKeyType=string`,
    ),
  ];
  const evaluation = awsJson(
    plan,
    profile,
    [
      "iam",
      "simulate-principal-policy",
      "--policy-source-arn",
      principalArn,
      "--action-names",
      actionName,
      "--resource-arns",
      "*",
      "--context-entries",
      ...contextEntries,
      "--output",
      "json",
    ],
    `${actionName} IAM policy simulation`,
  ).EvaluationResults?.[0];
  if (
    evaluation?.EvalActionName !== actionName ||
    evaluation?.EvalDecision !== "allowed" ||
    (evaluation.MissingContextValues || []).length !== 0
  ) {
    throw new Error(`${actionName} IAM policy simulation did not allow allocation`);
  }
  return {
    actionName,
    decision: evaluation.EvalDecision,
    principalArn,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameDimensionSet(observed, expected) {
  return (
    Array.isArray(observed) &&
    observed.length === expected.length &&
    expected.every((entry) =>
      observed.some((candidate) => sameJson(candidate, entry)),
    )
  );
}

export function assertMacosBudgetLaunchGate(plan, profile) {
  const identity = awsJson(
    plan,
    profile,
    ["sts", "get-caller-identity", "--output", "json"],
    "AWS account identity preflight",
  );
  if (identity.Account !== plan.account.id) {
    throw new Error("AWS account identity mismatch");
  }
  const workflow = ghJson(
    [
      "api",
      `repos/${plan.repository}/actions/workflows/${plan.github.workflowId}`,
    ],
    undefined,
    "GitHub macOS workflow preflight",
  );
  if (workflow.state !== plan.github.requiredState) {
    throw new Error(
      `macOS workflow must be ${plan.github.requiredState}; observed ${workflow.state || "unknown"}`,
    );
  }
  const stack = awsJson(
    plan,
    profile,
    [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      "kungfu-buildchain-macos-jit",
      "--output",
      "json",
    ],
    "macOS control-plane stack preflight",
  ).Stacks?.[0];
  if (!stack || !/(?:CREATE|UPDATE)_COMPLETE$/.test(stack.StackStatus || "")) {
    throw new Error("macOS control-plane stack is not complete");
  }
  const topicArn = (stack.Outputs || []).find(
    (entry) => entry.OutputKey === "KillSwitchTopic",
  )?.OutputValue;
  if (!/^arn:aws:sns:/.test(String(topicArn || ""))) {
    throw new Error("macOS Budget kill-switch topic readback failed");
  }
  const budget = awsJson(
    plan,
    profile,
    [
      "budgets",
      "describe-budget",
      "--account-id",
      plan.account.id,
      "--budget-name",
      plan.safety.budget.name,
      "--show-filter-expression",
      "--output",
      "json",
    ],
    "macOS Budget preflight",
  ).Budget;
  const expectedDimensions = [
    ["USAGE_TYPE", plan.safety.budget.dimensionFilter.usageType],
    ["OPERATION", plan.safety.budget.dimensionFilter.operation],
    ["REGION", plan.safety.budget.dimensionFilter.region],
  ].map(([Key, value]) => ({
    Dimensions: { Key, Values: [value], MatchOptions: ["EQUALS"] },
  }));
  if (
    !budget ||
    budget.BudgetName !== plan.safety.budget.name ||
    Number(budget.BudgetLimit?.Amount) !== plan.safety.budget.limitUsd ||
    budget.BudgetLimit?.Unit !== "USD" ||
    budget.BudgetType !== "COST" ||
    !sameJson(budget.Metrics, plan.safety.budget.metrics) ||
    !sameDimensionSet(budget.FilterExpression?.And, expectedDimensions)
  ) {
    throw new Error("macOS Budget identity or dimension filter mismatch");
  }
  const notifications = awsJson(
    plan,
    profile,
    [
      "budgets",
      "describe-notifications-for-budget",
      "--account-id",
      plan.account.id,
      "--budget-name",
      plan.safety.budget.name,
      "--output",
      "json",
    ],
    "macOS Budget notifications preflight",
  ).Notifications;
  const thresholds = (notifications || [])
    .filter(
      (entry) =>
        entry.NotificationType === "ACTUAL" &&
        (entry.ThresholdType || "PERCENTAGE") === "PERCENTAGE",
    )
    .map((entry) => Number(entry.Threshold))
    .sort((left, right) => left - right);
  if (!sameJson(thresholds, plan.safety.budget.requiredActualThresholds)) {
    throw new Error("macOS Budget notification thresholds mismatch");
  }
  for (const notification of notifications) {
    const subscribers = awsJson(
      plan,
      profile,
      [
        "budgets",
        "describe-subscribers-for-notification",
        "--account-id",
        plan.account.id,
        "--budget-name",
        plan.safety.budget.name,
        "--notification",
        JSON.stringify(notification),
        "--output",
        "json",
      ],
      `macOS Budget ${notification.Threshold}% subscribers preflight`,
    ).Subscribers;
    if (
      !(subscribers || []).some(
        (entry) =>
          entry.SubscriptionType === "SNS" && entry.Address === topicArn,
      )
    ) {
      throw new Error("macOS Budget SNS subscriber mismatch");
    }
  }
  return {
    accountId: identity.Account,
    principalArn: identity.Arn,
    workflowState: workflow.state,
    stackStatus: stack.StackStatus,
    budgetName: budget.BudgetName,
    budgetDimensionFilter: plan.safety.budget.dimensionFilter,
    budgetThresholds: thresholds,
  };
}
