// Published names forward to the canonical implementation.
export * from "../core/tail-reseal-receipt.js";
export {
  TAIL_RESEAL_RECEIPT_CONTRACT as V4_TAIL_RESEAL_RECEIPT_CONTRACT,
  createTailResealReceipt as createV4TailResealReceipt,
  verifyTailResealReceipt as verifyV4TailResealReceipt,
} from "../core/tail-reseal-receipt.js";
