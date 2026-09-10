import { ContractFault } from "../contracts/canonical-contracts.js";
import { DomainWasmFault, invokeDomainWasm } from "../runtime/domain-wasm.js";

export const RELEASE_INVOCATION_CONTRACT =
  "kungfu-buildchain-v4-release-invocation/v1";
export const RELEASE_INVOCATION_ADAPTER_CONTRACT =
  "kungfu-buildchain-v4-release-invocation-adapter/v1";
export const RELEASE_TRANSACTION_CONTRACT =
  "kungfu-buildchain-v4-release-transaction/v1";
export const RELEASE_RECEIPT_CONTRACT =
  "kungfu-buildchain-v4-release-receipt/v1";
export const RELEASE_PROVIDER_CONTRACT =
  "kungfu-buildchain-release-tail-provider/v1";

function invoke(operation, payload) {
  try {
    return invokeDomainWasm(operation, payload);
  } catch (error) {
    if (error instanceof DomainWasmFault) {
      throw new ContractFault(error.code, error.path, error.message);
    }
    throw error;
  }
}

export function createReleaseInvocation(value) {
  const projected = invoke("release-invocation", value);
  return { ...projected, invocation: value };
}

export function adaptReleaseInvocation(value) {
  const projected = invoke("release-invocation-adapter", value);
  return { ...projected, invocation: value.invocation };
}

export function planReleaseRoute({
  requestedSha,
  observedSha,
  comparisonStatus,
  requestedChannel = "",
  targetRef,
  dryRun = false,
  resume = false,
}) {
  return Object.freeze(
    invoke("release-route", {
      requestedSha,
      observedSha,
      comparisonStatus,
      requestedChannel,
      targetRef,
      dryRun,
      resume,
    }),
  );
}

export function createDomainReleaseTransaction(value) {
  return invoke("release-transaction", value);
}

export function createReleaseReceipt(value) {
  return invoke("release-receipt", value);
}
