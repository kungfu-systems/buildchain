import path from "node:path";
import { deliveryActionContext } from "./action-context.js";
import { sealNativeExecution } from "./transfer.js";
export function sealNativeExecutionAction(core, env) {
  const { workspace, runner } = deliveryActionContext(core, env);
  const result = sealNativeExecution({
    directory: path.join(workspace, ".buildchain/native-raw"),
    stagingDirectory: path.join(
      workspace,
      ".buildchain/native-transfer-staging",
    ),
    runtimeSelectionRoot: core.getInput("runtime-selection-root", {
      required: true,
    }),
    runner,
  });
  core.setOutput("root", result.transferRoot);
  core.setOutput("native-outcome", result.outcome);
}
