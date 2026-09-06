import { V4ContractFault } from "./v4-canonical-contracts.js";
import { V4DomainWasmFault, invokeV4DomainWasm } from "./v4-domain-wasm.js";

export const V4_RELEASE_ACTIVATION_REQUEST_CONTRACT =
  "buildchain-v4-release-activation-request/v1";
export const V4_RELEASE_ACTIVATION_PLAN_CONTRACT =
  "buildchain-v4-release-activation-plan/v1";
export const V4_RELEASE_ACTIVATION_STATE_CONTRACT =
  "buildchain-v4-release-activation-state/v1";

function project(request) {
  try {
    return invokeV4DomainWasm("release-activation", request);
  } catch (error) {
    if (error instanceof V4DomainWasmFault) {
      throw new V4ContractFault(error.code, error.path, error.message);
    }
    throw error;
  }
}

export function planV4ReleaseActivation(request) {
  return project(request).plan;
}

export function foldV4ReleaseActivation(request) {
  return project(request).state;
}

export function projectV4ReleaseActivation(request) {
  return project(request);
}
