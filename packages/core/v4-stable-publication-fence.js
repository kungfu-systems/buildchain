import { V4ContractFault } from "./v4-canonical-contracts.js";
import { V4DomainWasmFault, invokeV4DomainWasm } from "./v4-domain-wasm.js";

export const V4_STABLE_PUBLICATION_REQUEST_CONTRACT =
  "buildchain-v4-stable-publication-request/v1";
export const V4_STABLE_PUBLICATION_PLAN_CONTRACT =
  "buildchain-v4-stable-publication-plan/v1";
export const V4_STABLE_PUBLICATION_FENCE_CONTRACT =
  "buildchain-v4-stable-publication-fence/v1";

function project(request) {
  try {
    return invokeV4DomainWasm("stable-publication", request);
  } catch (error) {
    if (error instanceof V4DomainWasmFault) {
      throw new V4ContractFault(error.code, error.path, error.message);
    }
    throw error;
  }
}

export function planV4StablePublication(request) {
  return project(request).plan;
}

export function projectV4StablePublication(request) {
  return project(request);
}
