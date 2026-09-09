import { ContractFault } from "../contracts/canonical-contracts.js";
import { DomainWasmFault, invokeDomainWasm } from "../runtime/domain-wasm.js";

export const RELEASE_ACTIVATION_REQUEST_CONTRACT =
  "buildchain-v4-release-activation-request/v1";
export const RELEASE_ACTIVATION_PLAN_CONTRACT =
  "buildchain-v4-release-activation-plan/v1";
export const RELEASE_ACTIVATION_STATE_CONTRACT =
  "buildchain-v4-release-activation-state/v1";

function project(request) {
  try {
    return invokeDomainWasm("release-activation", request);
  } catch (error) {
    if (error instanceof DomainWasmFault) {
      throw new ContractFault(error.code, error.path, error.message);
    }
    throw error;
  }
}

export function planReleaseActivation(request) {
  return project(request).plan;
}

export function foldReleaseActivation(request) {
  return project(request).state;
}

export function projectReleaseActivation(request) {
  return project(request);
}
