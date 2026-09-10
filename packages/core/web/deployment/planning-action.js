import fs from "node:fs";
import { buildWebDeployment } from "./planning.js";

export async function webDeploymentPlanAction(core, env) {
  const read = (name) => JSON.parse(core.getInput(name, { required: true }));
  const emit = (values) => {
    for (const [key, value] of Object.entries(values))
      core.setOutput(key, value);
  };
  emit(
    await buildWebDeployment(
      {
        request: read("request-json"),
        runtime: read("runtime-json"),
        intent: read("intent-json"),
        selection: read("selection-json"),
        workspace: env.GITHUB_WORKSPACE,
        event: {
          name: env.GITHUB_EVENT_NAME,
          payload: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
          actor: env.GITHUB_ACTOR,
          runId: env.GITHUB_RUN_ID,
        },
      },
      emit,
    ),
  );
}
