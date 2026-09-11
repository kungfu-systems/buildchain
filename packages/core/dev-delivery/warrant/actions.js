import {
  deliveryActionContext,
  selectedDeliveryActionContext,
} from "../native/action-context.js";
import { settleNativeFailure } from "./failure-settlement.js";
import { settleTerminalDelivery } from "./terminal.js";
import { cancelQueuedDelivery } from "./cancellation.js";
import { jsonList } from "./values.js";
function connection(core, env) {
  return {
    repository: env.GITHUB_REPOSITORY,
    token: core.getInput("token", { required: true }),
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
  };
}
function emit(core, result) {
  for (const [name, value] of Object.entries(result))
    core.setOutput(name, value);
}
export async function settleNativeFailureAction(core, env) {
  const context = deliveryActionContext(core, env);
  const result = await settleNativeFailure({
    ...context,
    ...connection(core, env),
    branch: core.getInput("branch", { required: true }),
  });
  core.setOutput("receipt-root", result.receiptRoot);
}
export async function settleTerminalDeliveryAction(core, env) {
  const context = selectedDeliveryActionContext(core, env);
  const input = JSON.parse(core.getInput("request-json", { required: true }));
  await settleTerminalDelivery(
    {
      ...context,
      connection: connection(core, env),
      request: {
        branch: input["target-branch"],
        outcome: input.outcome,
        expectedSourceHead: input["expected-head-sha"],
        pullRequestNumber: Number(input["expected-pr-number"]),
        evidenceRoot: input["terminal-evidence-root"],
        currentBase: input["current-base-sha"],
        replayTree: input["replay-tree-sha"],
        mergeGroupHead: input["merge-group-head-sha"],
        mergeGroupTree: input["merge-group-tree-sha"],
        requiredContextRoots: jsonList(
          input["required-context-roots-json"],
          "required context roots",
        ),
        reason: input.reason,
      },
    },
    { onSettlement: (result) => emit(core, result) },
  );
}
export async function cancelQueuedDeliveryAction(core, env) {
  const context = selectedDeliveryActionContext(core, env);
  const input = JSON.parse(core.getInput("request-json", { required: true }));
  emit(
    core,
    await cancelQueuedDelivery({
      ...context,
      connection: connection(core, env),
      request: {
        branch: input["target-branch"],
        pullRequestNumber: Number(input["expected-pr-number"]),
        candidateId: input["expected-candidate-id"],
        expectedSourceHead: input["expected-source-head-sha"],
        observedSourceHead: input["observed-source-head-sha"],
        expectedOldStateRoot: input["expected-old-state-root"],
        eventAction: input["event-action"],
        outcome: input.outcome,
        evidenceRoot: input["terminal-evidence-root"],
        reason: input.reason,
      },
    }),
  );
}
