#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createWindowsJitCampaignArmPlan,
  windowsCampaignArmItems,
  windowsCampaignKillArgs,
} from "./aws-windows-jit-campaign-core.mjs";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || "";
}

function aws(plan, serviceArgs) {
  const profile = arg("aws-profile");
  const result = spawnSync(
    "aws",
    [
      ...(profile ? ["--profile", profile] : []),
      "--region",
      plan.aws.region,
      ...serviceArgs,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "")
      .trim()
      .slice(0, 2000);
    throw new Error(
      `AWS campaign mutation failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout ? JSON.parse(result.stdout) : {};
}

function armPlan() {
  return createWindowsJitCampaignArmPlan({
    campaignId: arg("campaign-id"),
    sourceSha: arg("source-sha"),
    stateTable: arg("state-table"),
    region: arg("region", "us-east-1"),
    armedAt: arg("armed-at", new Date().toISOString()),
    expiresAt: arg("expires-at"),
    phaseSpendBaselineUsd: arg("phase-spend-baseline-usd"),
    maxAcceptedInstances: arg("max-accepted-instances"),
  });
}

function confirm(
  plan,
  { phaseSpendBaseline = true, maxAcceptedInstances = true } = {},
) {
  if (arg("confirm-campaign-id") !== plan.campaign.id) {
    throw new Error("--confirm-campaign-id must equal the campaign id");
  }
  if (arg("confirm-source-sha") !== plan.source.sha) {
    throw new Error("--confirm-source-sha must equal the exact source SHA");
  }
  if (arg("confirm-state-table") !== plan.aws.stateTable) {
    throw new Error(
      "--confirm-state-table must equal the campaign state table",
    );
  }
  if (
    phaseSpendBaseline &&
    (!arg("confirm-phase-spend-baseline-usd").trim() ||
      Number(arg("confirm-phase-spend-baseline-usd")) !==
        plan.limits.phaseSpendBaselineUsd)
  ) {
    throw new Error(
      "--confirm-phase-spend-baseline-usd must equal the phase spend baseline",
    );
  }
  if (
    maxAcceptedInstances &&
    (!arg("confirm-max-accepted-instances").trim() ||
      Number(arg("confirm-max-accepted-instances")) !==
        plan.limits.maxAcceptedInstances)
  ) {
    throw new Error(
      "--confirm-max-accepted-instances must equal the campaign slot ceiling",
    );
  }
}

function killSwitchTopic() {
  const topic = arg("kill-switch-topic");
  if (
    !/^arn:aws:sns:us-east-1:\d{12}:kungfu-buildchain-windows-jit-[A-Za-z0-9_-]+$/.test(
      topic,
    )
  ) {
    throw new Error(
      "--kill-switch-topic must be the dedicated Windows JIT SNS ARN",
    );
  }
  if (arg("confirm-kill-switch-topic") !== topic) {
    throw new Error(
      "--confirm-kill-switch-topic must equal the dedicated kill-switch topic",
    );
  }
  return topic;
}

export function main() {
  const mode = process.argv[2] || "plan-arm";
  if (["plan-arm", "arm-campaign"].includes(mode)) {
    const plan = armPlan();
    if (mode === "plan-arm") {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return plan;
    }
    confirm(plan);
    aws(plan, [
      "dynamodb",
      "transact-write-items",
      "--transact-items",
      JSON.stringify(windowsCampaignArmItems(plan)),
      "--output",
      "json",
    ]);
    const result = {
      contract: plan.contract,
      kind: "campaign-arm-result",
      status: "armed",
      campaign: plan.campaign,
      source: plan.source,
      aws: plan.aws,
      limits: plan.limits,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (mode === "kill-campaign") {
    const now = new Date();
    const plan = createWindowsJitCampaignArmPlan({
      campaignId: arg("campaign-id"),
      sourceSha: arg("source-sha"),
      stateTable: arg("state-table"),
      region: arg("region", "us-east-1"),
      armedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 1000).toISOString(),
      phaseSpendBaselineUsd: 0,
    });
    confirm(plan, {
      phaseSpendBaseline: false,
      maxAcceptedInstances: false,
    });
    const topic = killSwitchTopic();
    aws(
      plan,
      windowsCampaignKillArgs(
        plan.aws.stateTable,
        arg("reason", "operator-kill"),
        new Date().toISOString(),
      ),
    );
    const notification = aws(plan, [
      "sns",
      "publish",
      "--topic-arn",
      topic,
      "--message",
      JSON.stringify({
        contract: plan.contract,
        action: "kill-campaign",
        campaignId: plan.campaign.id,
        sourceSha: plan.source.sha,
      }),
      "--output",
      "json",
    ]);
    const result = {
      contract: plan.contract,
      kind: "campaign-kill-result",
      status: "killed",
      campaign: plan.campaign,
      source: plan.source,
      killSwitchTopic: topic,
      notificationMessageId: notification.MessageId || "",
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  throw new Error(`unsupported Windows JIT campaign mode: ${mode}`);
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
