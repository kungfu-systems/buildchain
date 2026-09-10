import { deliveryActionContext } from "./action-context.js";
import { nativeCandidateRequest } from "../candidate/request.js";
import {
  executeDeliveryNative,
  qualifyTransferredNative,
} from "./transactions.js";
import { admitProviderFinalizer } from "./finalizer-admission.js";
function request(core, env) {
  const candidate = JSON.parse(
    core.getInput("request-json", { required: true }),
  );
  return {
    request: candidate,
    candidate: nativeCandidateRequest(candidate, {
      repository: env.GITHUB_REPOSITORY,
      branch: core.getInput("branch", { required: true }),
    }),
  };
}
function outputs(core, result) {
  for (const [name, value] of Object.entries(result))
    core.setOutput(name, value);
}
export async function executeDeliveryNativeAction(core, env) {
  const context = deliveryActionContext(core, env);
  const input = request(core, env);
  outputs(
    core,
    await executeDeliveryNative({
      ...context,
      candidate: input.candidate,
      runtimeSelectionRoot: core.getInput("runtime-selection-root", {
        required: true,
      }),
      sourceProofRoot: core.getInput("source-proof-root", { required: true }),
      reusableNativeProof: input.request["native-proof-json"]
        ? JSON.parse(input.request["native-proof-json"])
        : null,
    }),
  );
}
export async function qualifyTransferredNativeAction(core, env) {
  const context = deliveryActionContext(core, env);
  outputs(
    core,
    await qualifyTransferredNative({
      ...context,
      candidate: request(core, env).candidate,
      sourceProofRoot: core.getInput("source-proof-root", { required: true }),
      token: core.getInput("token", { required: true }),
      apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    }),
  );
}
export async function admitProviderFinalizerAction(core, env) {
  const context = deliveryActionContext(core, env);
  outputs(
    core,
    await admitProviderFinalizer({
      ...context,
      repository: env.GITHUB_REPOSITORY,
      branch: core.getInput("branch", { required: true }),
      pullRequestNumber: Number(
        core.getInput("pull-request", { required: true }),
      ),
      sourceHead: core.getInput("source-head", { required: true }),
      runtimeSelectionRoot: core.getInput("runtime-selection-root", {
        required: true,
      }),
      token: core.getInput("token", { required: true }),
      apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    }),
  );
}
