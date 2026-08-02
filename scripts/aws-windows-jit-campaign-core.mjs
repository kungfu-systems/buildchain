// SPDX-License-Identifier: Apache-2.0

import {
  WINDOWS_EC2_JIT,
  windowsJitCampaignId,
} from "./aws-windows-jit-core.mjs";

export const AWS_WINDOWS_JIT_CAMPAIGN_CONTRACT =
  "kungfu-buildchain-aws-windows-jit-campaign/v1";

function exact(value, pattern, label) {
  const normalized = String(value || "").trim();
  if (!pattern.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function exactSha(value) {
  return exact(value, /^[0-9a-f]{40}$/i, "sourceSha").toLowerCase();
}

function epoch(value, label) {
  const milliseconds = new Date(value || "").getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return Math.floor(milliseconds / 1000);
}

function tableName(value) {
  return exact(
    value,
    /^kungfu-buildchain-windows-jit(?:-[A-Za-z0-9_.-]+)?$/,
    "stateTable",
  );
}

function number(value) {
  return { N: String(value) };
}

function string(value) {
  return { S: String(value) };
}

function runKey(plan) {
  return `RUN#${plan.github.runId}#${plan.github.runAttempt}#${plan.github.qualificationId}`;
}

export function createWindowsJitCampaignArmPlan(values = {}) {
  const armedAt = epoch(values.armedAt, "armedAt");
  const expiresAt = epoch(values.expiresAt, "expiresAt");
  if (expiresAt <= armedAt || expiresAt - armedAt > 86400) {
    throw new Error("campaign expiry must be within 24 hours after arming");
  }
  const reservationUsd =
    (WINDOWS_EC2_JIT.pricePerHourUsd *
      WINDOWS_EC2_JIT.maximumInstanceLifetimeMinutes) /
    60;
  return {
    schemaVersion: 1,
    contract: AWS_WINDOWS_JIT_CAMPAIGN_CONTRACT,
    kind: "campaign-arm-plan",
    campaign: {
      id: windowsJitCampaignId(values.campaignId),
      armedAt,
      expiresAt,
    },
    source: { sha: exactSha(values.sourceSha) },
    aws: {
      region: exact(
        values.region || WINDOWS_EC2_JIT.region,
        /^us-[a-z]+-\d$/,
        "region",
      ),
      stateTable: tableName(values.stateTable),
    },
    limits: {
      maxAcceptedInstances: WINDOWS_EC2_JIT.maxAcceptedInstances,
      reservationUsd,
      budgetLimitUsd: WINDOWS_EC2_JIT.budgetLimitUsd,
    },
  };
}

export function windowsCampaignArmItems(plan) {
  if (plan?.contract !== AWS_WINDOWS_JIT_CAMPAIGN_CONTRACT) {
    throw new Error("Windows JIT campaign arm plan contract is invalid");
  }
  const table = plan.aws.stateTable;
  const campaignPk = `CAMPAIGN#${plan.campaign.id}`;
  return [
    {
      Put: {
        TableName: table,
        Item: {
          pk: string("CONTROL"),
          state: string("ARMED"),
          campaign_id: string(plan.campaign.id),
          source_sha: string(plan.source.sha),
          armed_at: number(plan.campaign.armedAt),
          expires_epoch: number(plan.campaign.expiresAt),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
    {
      Put: {
        TableName: table,
        Item: {
          pk: string(campaignPk),
          state: string("ARMED"),
          source_sha: string(plan.source.sha),
          accepted_instances: number(0),
          reserved_usd: number(0),
          max_accepted_instances: number(plan.limits.maxAcceptedInstances),
          reservation_usd: number(plan.limits.reservationUsd),
          budget_limit_usd: number(plan.limits.budgetLimitUsd),
          armed_at: number(plan.campaign.armedAt),
          expires_epoch: number(plan.campaign.expiresAt),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
  ];
}

export function windowsCampaignReservationItems(plan, observedAt) {
  const now = epoch(observedAt, "observedAt");
  const runPk = runKey(plan);
  const campaignPk = `CAMPAIGN#${plan.campaign.id}`;
  const maxAccepted = plan.safety.campaignAcceptedInstanceCeiling;
  const reservation = plan.safety.campaignReservationUsd;
  return [
    {
      ConditionCheck: {
        TableName: plan.aws.stateTable,
        Key: { pk: string("CONTROL") },
        ConditionExpression:
          "#state = :armed AND campaign_id = :campaign AND source_sha = :source AND expires_epoch >= :now",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":armed": string("ARMED"),
          ":campaign": string(plan.campaign.id),
          ":source": string(plan.source.sha),
          ":now": number(now),
        },
      },
    },
    {
      Put: {
        TableName: plan.aws.stateTable,
        Item: {
          pk: string(runPk),
          state: string("RESERVED"),
          campaign_id: string(plan.campaign.id),
          source_sha: string(plan.source.sha),
          github_run_id: string(plan.github.runId),
          github_run_attempt: string(plan.github.runAttempt),
          qualification_id: string(plan.github.qualificationId),
          reserved_usd: number(reservation),
          observed_at: number(now),
          expires_at: number(now + 1209600),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
    {
      Update: {
        TableName: plan.aws.stateTable,
        Key: { pk: string(campaignPk) },
        UpdateExpression:
          "ADD accepted_instances :one, reserved_usd :reservation SET updated_at = :now",
        ConditionExpression:
          "#state = :armed AND source_sha = :source AND accepted_instances < :max AND reserved_usd <= :remaining",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":armed": string("ARMED"),
          ":source": string(plan.source.sha),
          ":one": number(1),
          ":reservation": number(reservation),
          ":max": number(maxAccepted),
          ":remaining": number(
            plan.safety.campaignBudgetLimitUsd - reservation,
          ),
          ":now": number(now),
        },
      },
    },
  ];
}

export function windowsCampaignMarkLaunchedArgs(plan, instanceId, observedAt) {
  return [
    "dynamodb",
    "update-item",
    "--table-name",
    plan.aws.stateTable,
    "--key",
    JSON.stringify({ pk: string(runKey(plan)) }),
    "--update-expression",
    "SET #state = :launched, instance_id = :instance, launched_at = :now",
    "--condition-expression",
    "#state = :reserved",
    "--expression-attribute-names",
    JSON.stringify({ "#state": "state" }),
    "--expression-attribute-values",
    JSON.stringify({
      ":launched": string("LAUNCHED"),
      ":reserved": string("RESERVED"),
      ":instance": string(instanceId),
      ":now": number(epoch(observedAt, "observedAt")),
    }),
    "--output",
    "json",
  ];
}

export function windowsCampaignKillArgs(stateTable, reason, observedAt) {
  return [
    "dynamodb",
    "update-item",
    "--table-name",
    tableName(stateTable),
    "--key",
    JSON.stringify({ pk: string("CONTROL") }),
    "--update-expression",
    "SET #state = :killed, reason = :reason, killed_at = :now",
    "--expression-attribute-names",
    JSON.stringify({ "#state": "state" }),
    "--expression-attribute-values",
    JSON.stringify({
      ":killed": string("KILLED"),
      ":reason": string(
        exact(reason, /^[a-z0-9][a-z0-9-]{2,63}$/, "reason"),
      ),
      ":now": number(epoch(observedAt, "observedAt")),
    }),
    "--output",
    "json",
  ];
}
