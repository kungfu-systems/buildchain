import { ContractFault } from "./canonical-contracts.js";
import { DomainWasmFault, invokeDomainWasm } from "./domain-wasm.js";

export const STABLE_PUBLICATION_REQUEST_CONTRACT =
  "buildchain-v4-stable-publication-request/v1";
export const STABLE_PUBLICATION_PLAN_CONTRACT =
  "buildchain-v4-stable-publication-plan/v1";
export const STABLE_PUBLICATION_FENCE_CONTRACT =
  "buildchain-v4-stable-publication-fence/v1";

function project(request) {
  try {
    return invokeDomainWasm("stable-publication", request);
  } catch (error) {
    if (error instanceof DomainWasmFault) {
      throw new ContractFault(error.code, error.path, error.message);
    }
    throw error;
  }
}

export function planStablePublication(request) {
  return project(request).plan;
}

export function projectStablePublication(request) {
  return project(request);
}
