import { V4ContractFault } from "./v4-canonical-contracts.js";
import { V4DomainWasmFault, invokeV4DomainWasm } from "./v4-domain-wasm.js";

export const V4_PARTIAL_MUTATION_RECOVERY_REQUEST_CONTRACT =
  "buildchain-v4-partial-mutation-recovery-request/v1";
export const V4_PARTIAL_MUTATION_RECOVERY_PLAN_CONTRACT =
  "buildchain-v4-partial-mutation-recovery-plan/v1";

export function planV4PartialMutationRecovery(request) {
  try {
    return invokeV4DomainWasm("partial-mutation-recovery", request);
  } catch (error) {
    if (error instanceof V4DomainWasmFault) {
      throw new V4ContractFault(error.code, error.path, error.message);
    }
    throw error;
  }
}
