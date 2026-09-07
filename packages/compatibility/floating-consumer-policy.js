// Published names forward to the canonical implementation.
export * from "../core/floating-consumer-policy.js";
export {
  FLOATING_CONSUMER_CERTIFICATION as V4_FLOATING_CONSUMER_CERTIFICATION,
  FLOATING_CONSUMER_POLICY as V4_FLOATING_CONSUMER_POLICY,
  FLOATING_CONSUMER_RECEIPT as V4_FLOATING_CONSUMER_RECEIPT,
  certifyFloatingConsumerPolicyReceipt as certifyV4FloatingConsumerPolicyReceipt,
  resolveFloatingConsumerPolicyAuthority as resolveV4FloatingConsumerPolicyAuthority,
  scanFloatingConsumerPolicy as scanV4FloatingConsumerPolicy,
  consumerPolicyScannerRoot as v4ConsumerPolicyScannerRoot,
  floatingConsumerDocumentRoot as v4FloatingConsumerDocumentRoot,
  verifyFloatingConsumerPolicyCertification as verifyV4FloatingConsumerPolicyCertification,
  verifyFloatingConsumerPolicyReceipt as verifyV4FloatingConsumerPolicyReceipt,
} from "../core/floating-consumer-policy.js";
