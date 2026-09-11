import { buildStageRecovery } from "../recovery/transaction.js";
import { readBuildActionContext } from "../plan/action-context.js";
import { runBuildStage } from "./stage.js";
export async function runBuildStageAction(core, env) {
  const context = readBuildActionContext(core, env);
  if (!context.platform)
    throw new Error("Build stage requires a declared platform");
  const environment = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("INPUT_")),
  );
  await runBuildStage({
    ...context,
    recovery: buildStageRecovery(context, core.getInput("token", { required: true })),
    stage: core.getInput("stage", { required: true }),
    environment: {
      ...environment,
      GITHUB_TOKEN: core.getInput("token", { required: true }),
    },
  });
}
