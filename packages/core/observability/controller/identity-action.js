import { installationRoot } from "../../runtime/installation-root.js";
import { controllerCheckoutIdentity } from "./identity.js";
export function identifyControllerCheckoutsAction(core, env) {
  for (const [key, value] of Object.entries(
    controllerCheckoutIdentity({
      workspace: env.GITHUB_WORKSPACE,
      runtimeRoot: installationRoot(import.meta.url),
    }),
  ))
    core.setOutput(key, value);
}
