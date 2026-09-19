import { recoveryInputs } from "../../consumer/contract/entries.js";
import { pipelineHost } from "./host.js";
import { controlPipelineRecovery } from "./recovery-controller.js";
import { pipelineActionOutputs } from "./action-output.js";
import { resumePipelineSession } from "./session.js";

export async function recoverPipelineAction(core, env) {
  const { attempt } = recoveryInputs({
    attempt: core.getInput("attempt", { required: true }),
  });
  const host = await pipelineHost(core, env, "Buildchain recovery controller");
  try {
    const result = await controlPipelineRecovery(
      attempt,
      core.getInput("definition-sha", { required: true }),
      host,
    );
    pipelineActionOutputs(core, result);
  } catch (error) {
    try {
      const session = await resumePipelineSession({ ...host, attempt }, host);
      await host.project(session);
    } catch {
      core.warning(
        "Recovery status projection is unavailable; the canonical attempt remains authoritative.",
      );
    }
    throw error;
  }
}
