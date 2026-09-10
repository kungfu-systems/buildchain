import { selectRuntime } from "../../packages/core/runtime/runtime-selection.js";

// Exercise the shared domain contract against the existing purpose-specific
// authority scenarios. No production adapter or environment mutation is used.
function resolver(purpose) {
  return async ({ env, core, github, context }) => {
    const result = await selectRuntime(
      {
        purpose,
        repository: env.BUILDCHAIN_REPOSITORY,
        requestedRef: env.BUILDCHAIN_REQUESTED_REF,
        workflowSha: env.BUILDCHAIN_WORKFLOW_SHA,
        workflowRef: env.BUILDCHAIN_WORKFLOW_REF,
      },
      { github, context },
    );
    for (const [key, value] of Object.entries(result))
      core.setOutput(key, value);
    return result;
  };
}
export const resolvePublicationRuntime = resolver("publication");
export const resolveWebRuntime = resolver("web");
export const resolveGateRuntime = resolver("gate");
