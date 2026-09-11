import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
export function deliveryActionContext(core, env) {
  const runtimeRoot = installationRoot(import.meta.url);
  return {
    workspace: path.resolve(env.GITHUB_WORKSPACE),
    runtimeRoot,
    runtimeSha: env.BUILDCHAIN_RUNTIME_SHA,
    runtimeRef: env.BUILDCHAIN_RUNTIME_REF,
    run: {
      id: Number(env.GITHUB_RUN_ID),
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
    },
    runner: {
      name: env.RUNNER_NAME,
      os: env.RUNNER_OS,
      arch: env.RUNNER_ARCH,
      environment: core.getInput("runner-environment"),
    },
  };
}

export function selectedDeliveryActionContext(core, env) {
  const runtimeRoot = installationRoot(import.meta.url);
  return {
    workspace: path.resolve(env.GITHUB_WORKSPACE),
    runtimeRoot,
    runtimeSha: env.BUILDCHAIN_RUNTIME_SHA,
    runtimeRef: env.BUILDCHAIN_RUNTIME_REF,
  };
}
