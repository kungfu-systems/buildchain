import fs from "node:fs";
import { outputs } from "./io.mjs";
import { command, requireValue } from "../../runtime/action-process.mjs";

export function handoffInputs(warrant, env) {
  requireValue(
    env.HANDOFF_WORKFLOW_ID,
    "Active Warrant belongs to another candidate but no immediate handoff workflow was configured",
  );
  requireValue(
    Number.isSafeInteger(warrant.sourceWorkflowRunId) &&
      warrant.sourceWorkflowRunId > 0,
    "Active Warrant handoff requires its recorded exact source workflow run",
  );
  const fields = {
    "target-branch": env.TARGET_BRANCH,
    "expected-pr-number": warrant.pullRequestNumber,
    "expected-head-sha": warrant.sourceHead,
    "source-workflow-run-id": warrant.sourceWorkflowRunId,
    "native-roots-json": JSON.stringify({ sourceRoot: warrant.sourceRoot }),
    "source-identity-root": warrant.sourceIdentityRoot,
    "source-patch-root": warrant.sourcePatchRoot,
    "plan-root": warrant.planRoot,
    "closure-root": warrant.closureRoot,
    "dependency-root": warrant.dependencyRoot,
    "toolchain-root": warrant.toolchainRoot,
    "affected-paths-json": JSON.stringify(warrant.affectedPaths || []),
    "shard-evidence-roots-json": JSON.stringify(
      warrant.shardEvidenceRoots || [],
    ),
    "release-blocker-priority-json": warrant.releaseBlockerPriority
      ? JSON.stringify(warrant.releaseBlockerPriority)
      : "",
    "delivery-class": warrant.deliveryClass,
    "delivery-priority": warrant.priority || "ordinary",
  };
  if (warrant.phase !== "ready") {
    requireValue(
      warrant.environmentRoot &&
        warrant.nativeCommandContract?.command &&
        warrant.nativeCommandContract?.commandRoot,
      "Native handoff requires its exact environment and command",
    );
    Object.assign(fields, {
      "environment-root": warrant.environmentRoot,
      "native-command": warrant.nativeCommandContract.command,
      "native-command-root": warrant.nativeCommandContract.commandRoot,
      "native-heartbeat-seconds": env.HEARTBEAT_SECONDS,
    });
  }
  for (const [key, value] of Object.entries(fields))
    requireValue(value != null, `Active handoff ${key} is missing`);
  return fields;
}
export function dispatchHandoff(warrant, result, env) {
  const fields = handoffInputs(warrant, env);
  command("gh", [
    "workflow",
    "run",
    env.HANDOFF_WORKFLOW_ID,
    "--repo",
    env.GITHUB_REPOSITORY,
    "--ref",
    env.TARGET_BRANCH,
    ...Object.entries(fields).flatMap(([key, value]) => [
      "-f",
      `${key}=${value}`,
    ]),
  ]);
  fs.mkdirSync(".buildchain/dev-pr-auto-merge", { recursive: true });
  fs.writeFileSync(
    ".buildchain/dev-pr-auto-merge/result.json",
    JSON.stringify(
      {
        schema: "kungfu.buildchain.dev-warrant-handoff/v1",
        ok: true,
        outcome: "active-warrant-handoff-dispatched",
        requested: {
          pullRequestNumber: Number(env.EXPECTED_PR),
          sourceHead: env.EXPECTED_HEAD,
        },
        active: {
          pullRequestNumber: warrant.pullRequestNumber,
          sourceHead: warrant.sourceHead,
          sourceWorkflowRunId: warrant.sourceWorkflowRunId,
          stateRoot: result.observation.stateRoot,
          fencingToken: warrant.fencingToken,
          generation: warrant.generation,
        },
      },
      null,
      2,
    ) + "\n",
  );
  outputs({
    "handoff-required": "true",
    "handoff-dispatched": "true",
    "active-pr-number": warrant.pullRequestNumber,
    "active-head-sha": warrant.sourceHead,
  });
}
