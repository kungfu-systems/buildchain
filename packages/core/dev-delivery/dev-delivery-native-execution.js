import {
  devDeliveryClone as clone,
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryProtectedBase as protectedBase,
  devDeliveryRepository as repository,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";

export const NATIVE_EXECUTION_BINDING_SCHEMA =
  "kungfu.buildchain.native-execution-binding/v2";
export const NATIVE_COMMAND_CONTRACT_SCHEMA =
  "kungfu.buildchain.native-command-contract/v1";
export const NATIVE_EXECUTION_RECEIPT_SCHEMA =
  "kungfu.buildchain.native-heartbeat-run-receipt/v3";

export function createNativeCommandContract(commandInput) {
  const command = text(commandInput);
  if (!command) throw new Error("native command is required");
  const contract = {
    schema: NATIVE_COMMAND_CONTRACT_SCHEMA,
    runner: "bash-lc",
    command,
  };
  return { ...contract, commandRoot: devDeliveryContentRoot(contract) };
}

export function normalizeNativeCommandContract(input = {}) {
  const contract = createNativeCommandContract(input.command);
  if (input.schema && input.schema !== contract.schema) {
    throw new Error("native command contract schema is unsupported");
  }
  if (input.runner && input.runner !== contract.runner) {
    throw new Error("native command contract runner is unsupported");
  }
  if (input.commandRoot && input.commandRoot !== contract.commandRoot) {
    throw new Error("native command contract root drift");
  }
  return contract;
}

export function createNativeExecutionBinding(input = {}) {
  return {
    schema: NATIVE_EXECUTION_BINDING_SCHEMA,
    repository: repository(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    sourceHead: exactSha(input.sourceHead, "sourceHead"),
    qualifiedBase: exactSha(input.qualifiedBase, "qualifiedBase"),
    nativeCommandRoot: exactRoot(input.nativeCommandRoot, "nativeCommandRoot"),
    toolchainRoot: exactRoot(input.toolchainRoot, "toolchainRoot"),
    environmentRoot: exactRoot(input.environmentRoot, "environmentRoot"),
  };
}

export function createNativeExecutionReceipt(input = {}) {
  const executionBinding = createNativeExecutionBinding(input.executionBinding);
  const receipt = {
    schema: NATIVE_EXECUTION_RECEIPT_SCHEMA,
    outcome: input.outcome === "succeeded" ? "succeeded" : text(input.outcome),
    commandRoot: exactRoot(input.commandRoot, "commandRoot"),
    executionBinding,
    executionBindingRoot: devDeliveryContentRoot(executionBinding),
    startedAt: timestamp(input.startedAt, "startedAt"),
    completedAt: timestamp(input.completedAt, "completedAt"),
    heartbeatCount: Number(input.heartbeatCount),
  };
  if (receipt.outcome !== "succeeded")
    throw new Error("native execution receipt must record succeeded outcome");
  if (receipt.commandRoot !== receipt.executionBinding.nativeCommandRoot) {
    throw new Error("native execution receipt command root is not authorized");
  }
  if (!Number.isInteger(receipt.heartbeatCount) || receipt.heartbeatCount < 1)
    throw new Error("heartbeatCount must be a positive integer");
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt))
    throw new Error("native execution receipt completedAt precedes startedAt");
  return { ...receipt, receiptRoot: devDeliveryContentRoot(receipt) };
}

export function verifyNativeExecutionReceipt(receiptInput, expected = {}) {
  try {
    const receipt = clone(receiptInput || {});
    if (receipt.schema !== NATIVE_EXECUTION_RECEIPT_SCHEMA)
      return { ok: false, reason: "unsupported-schema" };
    const receiptRoot = receipt.receiptRoot;
    delete receipt.receiptRoot;
    if (devDeliveryContentRoot(receipt) !== receiptRoot)
      return { ok: false, reason: "receipt-root-drift" };
    const normalized = createNativeExecutionReceipt({
      ...receipt,
      executionBinding: receipt.executionBinding,
    });
    if (normalized.receiptRoot !== receiptRoot)
      return { ok: false, reason: "receipt-input-drift" };
    for (const [field, value] of Object.entries(expected)) {
      if (value !== undefined && receipt.executionBinding?.[field] !== value)
        return { ok: false, reason: `${field}-mismatch` };
    }
    return {
      ok: true,
      reason: "exact-native-execution-receipt",
      receiptRoot,
      executionBindingRoot: receipt.executionBindingRoot,
      receipt: normalized,
    };
  } catch (error) {
    return { ok: false, reason: "invalid-receipt", error: error.message };
  }
}
