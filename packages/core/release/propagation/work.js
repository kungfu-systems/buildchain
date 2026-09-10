import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  createReleasePropagationStageReceipt,
  recordReleasePropagationStage,
  verifyReleasePropagationWork,
  createReleasePropagationReceipt,
} from "../release-propagation.js";
import {
  propagationPaths,
  request,
  readPropagation,
  writePropagation,
} from "./store.js";

export function recordPropagationStage(context, stage, evidence) {
  const work = readPropagation("work.json", context);
  const receipt = createReleasePropagationStageReceipt({
    work,
    stage,
    outcome: "success",
    observedAt: new Date().toISOString(),
    actor: { kind: "automation", identity: "github-actions" },
    summary: `recorded ${stage}`,
    evidence,
    failure: null,
  });
  const next = recordReleasePropagationStage({
    work,
    expectedWorkRoot: work.contentRoot,
    receipt,
  });
  writePropagation("stage-receipt.json", receipt, context);
  writePropagation("work.json", next, context);
  return next;
}
export function recordMaterialization(context) {
  const lock = readPropagation("write-lock.json", context),
    plan = readPropagation("target.json", context),
    branch = readPropagation("branch.json", context),
    input = request(context);
  const evidence = {
    root: `sha256:${lock.lockSha256}`,
    repository: input["downstream-repository"],
    revision: branch.base_sha,
    httpStatus: null,
    bytes: 0,
    claims: null,
  };
  recordPropagationStage(context, "materialize", [
    { ...evidence, kind: "release-lock", locator: plan.lock_path },
  ]);
  recordPropagationStage(context, "verify-release", [
    {
      ...evidence,
      kind: "release-contract-verification",
      locator: "buildchain://release-propagation/verify-release",
    },
  ]);
}
export function recordDelivery(context) {
  const result = readPropagation("branch-reconciliation.json", context);
  const work = readPropagation("work.json", context);
  // The push stage is recorded immediately after verified provider readback.
  if (result.pullRequest.number && result.pullRequest.url) {
    const locator = result.pullRequest.url;
    const value = `${work.downstream.repository}#${result.pullRequest.number}:${locator}`;
    recordPropagationStage(context, "pull-request", [
      {
        kind: "github-pull-request",
        root: `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`,
        locator,
        repository: work.downstream.repository,
        revision: result.pushedSha,
        httpStatus: null,
        bytes: 0,
        claims: null,
      },
    ]);
  }
}
export function exposePropagationWork(context) {
  const work = readPropagation("work.json", context),
    status = verifyReleasePropagationWork(work);
  writePropagation("work-status.json", status, context);
  return {
    "work-json": JSON.stringify(work),
    "work-root": work.contentRoot,
    "next-action": `${status.nextAction.action}:${status.currentStage}`,
  };
}
export function propagationReceipt(context) {
  const input = request(context);
  const receipt = createReleasePropagationReceipt({
    plan: readPropagation("plan.json", context),
    target: input["downstream-target"],
    lockResult: readPropagation("write-lock.json", context),
    prOutcome: readPropagation("pr-outcome.json", context),
    stagingState: "pending",
    productionState: "not-requested",
    observedAt: new Date().toISOString(),
  });
  writePropagation("receipt.json", receipt, context);
  return {
    "receipt-json": JSON.stringify(receipt),
    "receipt-digest": receipt.receiptSha256,
  };
}
export function summarizePropagation(context) {
  const input = request(context),
    plan = readPropagation("target.json", context),
    lock = readPropagation("write-lock.json", context);
  const rows = {
    Downstream: plan.repository,
    Channel: plan.channel,
    "Lock path": plan.lock_path,
    "Lock SHA-256": lock.lockSha256,
    "Propagation key": plan.propagation_key,
    Branch: plan.branch,
    "Lock write": lock.status,
    "Dry run": input["dry-run"],
  };
  fs.appendFileSync(
    context.summaryPath,
    "## Release propagation\n\n" +
      Object.entries(rows)
        .map(([key, value]) => `- ${key}: \`${value}\`\n`)
        .join(""),
  );
}
export async function refreshPropagationBadges(context) {
  const { downstream } = propagationPaths(context);
  const file = path.join(downstream, "README.md");
  if (
    !fs.existsSync(file) ||
    !fs.readFileSync(file, "utf8").includes("<!-- buildchain:badges:start -->")
  ) {
    console.log(
      "No Buildchain-managed README badge block; nothing to refresh.",
    );
    return;
  }
  const { runReadmeBadgesCli } = await import("../../web/cli/badges.mjs");
  await runReadmeBadgesCli(["readme", "--cwd", downstream, "--write"]);
}
