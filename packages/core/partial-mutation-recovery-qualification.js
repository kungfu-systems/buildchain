import { ContractFault } from "./canonical-contracts.js";
import { DomainWasmFault, invokeDomainWasm } from "./domain-wasm.js";

export const PARTIAL_MUTATION_RECOVERY_REQUEST_CONTRACT =
  "buildchain-v4-partial-mutation-recovery-request/v1";
export const PARTIAL_MUTATION_RECOVERY_PLAN_CONTRACT =
  "buildchain-v4-partial-mutation-recovery-plan/v1";

export function planPartialMutationRecovery(request) {
  try {
    return invokeDomainWasm("partial-mutation-recovery", request);
  } catch (error) {
    if (error instanceof DomainWasmFault) {
      throw new ContractFault(error.code, error.path, error.message);
    }
    throw error;
  }
}
