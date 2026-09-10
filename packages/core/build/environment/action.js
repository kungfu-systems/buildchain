import os from "node:os";
import { readBuildActionContext } from "../plan/action-context.js";
import { provisionBuildEnvironment } from "./provision.js";
import { runnerObservation } from "../../providers/runner/observation.js";
export function provisionBuildEnvironmentAction(core, env) {
  const context = readBuildActionContext(core, env);
  const result = provisionBuildEnvironment({
    ...context,
    tools: core.getInput("tools") === "true",
    token: core.getInput("token", { required: true }),
    environment: env,
    observation: runnerObservation(env),
    runnerTemp: env.RUNNER_TEMP || os.tmpdir(),
    home: os.homedir(),
  });
  for (const directory of result.paths) core.addPath(directory);
}
