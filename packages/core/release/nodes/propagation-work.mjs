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
  propagationOutputs,
} from "./propagation-io.mjs";

export function recordPropagationStage(env, stage, evidence) {
  const work = readPropagation("work.json", env);
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
  writePropagation("stage-receipt.json", receipt, env);
  writePropagation("work.json", next, env);
  return next;
}
export function recordMaterialization(env) {
  const lock = readPropagation("write-lock.json", env),
    plan = JSON.parse(env.BUILDCHAIN_PROPAGATION_PLAN_JSON),
    branch = JSON.parse(env.BUILDCHAIN_PROPAGATION_BRANCH_JSON),
    input = request(env);
  const evidence = {
    root: `sha256:${lock.lockSha256}`,
    repository: input["downstream-repository"],
    revision: branch.base_sha,
    httpStatus: null,
    bytes: 0,
    claims: null,
  };
  recordPropagationStage(env, "materialize", [
    { ...evidence, kind: "release-lock", locator: plan.lock_path },
  ]);
  recordPropagationStage(env, "verify-release", [
    {
      ...evidence,
      kind: "release-contract-verification",
      locator: "buildchain://release-propagation/verify-release",
    },
  ]);
}
export function recordDelivery(env) {
  const result = readPropagation("branch-reconciliation.json", env);
  const work = readPropagation("work.json", env);
  // The push stage is recorded immediately after verified provider readback.
  if (result.pullRequest.number && result.pullRequest.url) {
    const locator = result.pullRequest.url;
    const value = `${work.downstream.repository}#${result.pullRequest.number}:${locator}`;
    recordPropagationStage(env, "pull-request", [
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
export function exposePropagationWork(env) {
  const work = readPropagation("work.json", env),
    status = verifyReleasePropagationWork(work);
  writePropagation("work-status.json", status, env);
  propagationOutputs({
    "work-json": JSON.stringify(work),
    "work-root": work.contentRoot,
    "next-action": `${status.nextAction.action}:${status.currentStage}`,
  });
}
export function propagationReceipt(env) {
  const input = request(env);
  const receipt = createReleasePropagationReceipt({
    plan: readPropagation("plan.json", env),
    target: input["downstream-target"],
    lockResult: readPropagation("write-lock.json", env),
    prOutcome: readPropagation("pr-outcome.json", env),
    stagingState: "pending",
    productionState: "not-requested",
    observedAt: new Date().toISOString(),
  });
  writePropagation("receipt.json", receipt, env);
  propagationOutputs({
    "receipt-json": JSON.stringify(receipt),
    "receipt-digest": receipt.receiptSha256,
  });
}
export function summarizePropagation(env) {
  const input = request(env),
    plan = JSON.parse(env.BUILDCHAIN_PROPAGATION_PLAN_JSON),
    lock = readPropagation("write-lock.json", env);
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
    env.GITHUB_STEP_SUMMARY,
    "## Release propagation\n\n" +
      Object.entries(rows)
        .map(([key, value]) => `- ${key}: \`${value}\`\n`)
        .join(""),
  );
}
export async function refreshPropagationBadges(env) {
  const { downstream } = propagationPaths(env);
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
