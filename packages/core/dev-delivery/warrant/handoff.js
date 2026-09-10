import path from "node:path";
import { requireValue } from "../../runtime/action-process.mjs";
import { writeJson } from "../native/files.js";
export function handoffInputs(
  warrant,
  { workflowId, branch, heartbeatSeconds },
) {
  requireValue(
    workflowId,
    "Active Warrant belongs to another candidate but no immediate handoff workflow was configured",
  );
  requireValue(
    Number.isSafeInteger(warrant.sourceWorkflowRunId) &&
      warrant.sourceWorkflowRunId > 0,
    "Active Warrant handoff requires its recorded exact source workflow run",
  );
  const fields = {
    "target-branch": branch,
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
    "affected-paths-json": "[]",
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
      "native-heartbeat-seconds": heartbeatSeconds,
    });
  }
  for (const [key, value] of Object.entries(fields))
    requireValue(value != null, `Active handoff ${key} is missing`);
  return fields;
}
export async function dispatchDeliveryHandoff(
  {
    warrant,
    result,
    requested,
    workspace,
    repository,
    workflowId,
    branch,
    heartbeatSeconds,
  },
  provider,
) {
  const fields = handoffInputs(warrant, {
    workflowId,
    branch,
    heartbeatSeconds,
  });
  await provider.request(
    `/repos/${repository}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
    {
      method: "POST",
      body: {
        ref: branch,
        inputs: Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [key, String(value)]),
        ),
      },
    },
  );
  writeJson(path.join(workspace, ".buildchain/dev-pr-auto-merge/result.json"), {
    schema: "kungfu.buildchain.dev-warrant-handoff/v1",
    ok: true,
    outcome: "active-warrant-handoff-dispatched",
    requested,
    active: {
      pullRequestNumber: warrant.pullRequestNumber,
      sourceHead: warrant.sourceHead,
      sourceWorkflowRunId: warrant.sourceWorkflowRunId,
      stateRoot: result.observation.stateRoot,
      fencingToken: warrant.fencingToken,
      generation: warrant.generation,
    },
  });
  return {
    "handoff-required": "true",
    "handoff-dispatched": "true",
    "active-pr-number": warrant.pullRequestNumber,
    "active-head-sha": warrant.sourceHead,
  };
}
