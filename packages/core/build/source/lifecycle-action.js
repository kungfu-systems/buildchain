import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { qualifySourceLifecycle } from "./lifecycle.js";

export async function qualifySourceLifecycleAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  return qualifySourceLifecycle(
    {
      workspace: env.GITHUB_WORKSPACE,
      cwd: path.resolve(
        env.GITHUB_WORKSPACE,
        request["working-directory"] || ".",
      ),
      runtimeRoot: installationRoot(import.meta.url),
      runtimeRef: core.getInput("runtime-ref", { required: true }),
      mode: request.mode,
      requireVersionState: request["require-version-state"] === true,
      env,
    },
    {
      observe(state) {
        for (const [output, phase] of [
          ["lifecycle-stage", "stage"],
          ["validate-outcome", "validate"],
          ["install-outcome", "install"],
          ["selected-check-outcome", "check"],
        ])
          core.setOutput(output, state[phase]);
      },
    },
  );
}
