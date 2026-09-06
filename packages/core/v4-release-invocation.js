import { V4ContractFault } from "./v4-canonical-contracts.js";
import { V4DomainWasmFault, invokeV4DomainWasm } from "./v4-domain-wasm.js";

export const V4_RELEASE_INVOCATION_CONTRACT =
  "kungfu-buildchain-v4-release-invocation/v1";
export const V4_RELEASE_INVOCATION_ADAPTER_CONTRACT =
  "kungfu-buildchain-v4-release-invocation-adapter/v1";
export const V4_RELEASE_TRANSACTION_CONTRACT =
  "kungfu-buildchain-v4-release-transaction/v1";
export const V4_RELEASE_RECEIPT_CONTRACT =
  "kungfu-buildchain-v4-release-receipt/v1";
export const V4_RELEASE_PROVIDER_CONTRACT =
  "kungfu-buildchain-release-tail-provider/v1";

function invoke(operation, payload) {
  try {
    return invokeV4DomainWasm(operation, payload);
  } catch (error) {
    if (error instanceof V4DomainWasmFault) {
      throw new V4ContractFault(error.code, error.path, error.message);
    }
    throw error;
  }
}

export function createV4ReleaseInvocation(value) {
  const projected = invoke("release-invocation", value);
  return { ...projected, invocation: value };
}

export function adaptV4ReleaseInvocation(value) {
  const projected = invoke("release-invocation-adapter", value);
  return { ...projected, invocation: value.invocation };
}

export function planV4ReleaseRoute({
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

export function createV4ReleaseTransaction(value) {
  return invoke("release-transaction", value);
}

export function createV4ReleaseReceipt(value) {
  return invoke("release-receipt", value);
}
