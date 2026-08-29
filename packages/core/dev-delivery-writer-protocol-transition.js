import { devDeliveryContentRoot } from "./dev-delivery-common.js";
import {
  DEV_DELIVERY_MINIMUM_WRITER_PROTOCOL_ROOT,
  TERMINAL_STATES,
  transitionDevDeliveryQueue,
} from "./dev-delivery-warrant-state.js";

export const DEV_DELIVERY_WRITER_PROTOCOL = Object.freeze({
  schema: "kungfu.buildchain.dev-delivery-writer-protocol/v1",
  requiredCandidateCapabilities: [
    "environment-root-v1",
    "native-command-contract-v1",
  ],
});
export const DEV_DELIVERY_WRITER_PROTOCOL_FENCE_RECEIPT_SCHEMA =
  "kungfu.buildchain.dev-delivery-writer-protocol-fence-receipt/v1";
if (
  devDeliveryContentRoot(DEV_DELIVERY_WRITER_PROTOCOL) !==
  DEV_DELIVERY_MINIMUM_WRITER_PROTOCOL_ROOT
) {
  throw new Error("dev delivery writer protocol root drift");
}

export function fenceDevDeliveryWriterProtocol(
  queueInput,
  { now = new Date().toISOString() } = {},
) {
  const transaction = transitionDevDeliveryQueue(
    queueInput,
    (queue) => {
      if (
        queue.policy.minimumWriterProtocolRoot ===
        DEV_DELIVERY_MINIMUM_WRITER_PROTOCOL_ROOT
      ) {
        return {
          action: "minimum-writer-protocol-already-fenced",
          preserveState: true,
        };
      }
      if (
        queue.activeWarrant ||
        queue.candidates.some(
          (candidate) => !TERMINAL_STATES.has(candidate.status),
        )
      ) {
        throw new Error(
          "minimum writer protocol can be fenced only while the queue is idle",
        );
      }
      queue.policy.minimumWriterProtocolRoot =
        DEV_DELIVERY_MINIMUM_WRITER_PROTOCOL_ROOT;
      return { action: "minimum-writer-protocol-fenced" };
    },
    now,
  );
  const receipt = {
    schema: DEV_DELIVERY_WRITER_PROTOCOL_FENCE_RECEIPT_SCHEMA,
    action: transaction.result.action,
    repository: transaction.after.repository,
    protectedBase: transaction.after.protectedBase,
    minimumWriterProtocolRoot: DEV_DELIVERY_MINIMUM_WRITER_PROTOCOL_ROOT,
    expectedOldStateRoot: transaction.expectedOldStateRoot,
    nextStateRoot: transaction.after.stateRoot,
    nextAction:
      "Use only a Buildchain runtime that preserves the rooted minimum writer protocol.",
  };
  return {
    queue: transaction.after,
    receipt,
    receiptRoot: devDeliveryContentRoot(receipt),
  };
}
