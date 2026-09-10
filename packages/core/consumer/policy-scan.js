import fs from "node:fs";
import path from "node:path";
import {
  scanFloatingConsumerPolicy,
  consumerPolicyScannerRoot,
} from "./floating-consumer-policy.js";
export function scanConsumerPolicy({ runtimeRoot, output, ...options }) {
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(runtimeRoot, "architecture/floating-consumer-policy.json"),
      "utf8",
    ),
  );
  const result = scanFloatingConsumerPolicy({
    ...options,
    policy,
    scannerRoot: consumerPolicyScannerRoot(runtimeRoot),
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  return result;
}
export function consumerPolicyOutputs(result, output) {
  return {
    "v4-consumer-policy-status": result.ok ? "passed" : "failed",
    "v4-consumer-policy-receipt-path": output,
    "v4-consumer-policy-receipt-root": result.receiptRoot,
    "v4-consumer-policy-receipt-json": JSON.stringify(result.receipt),
    "v4-consumer-policy-channel": result.receipt.invocation.channel,
    "v4-consumer-policy-selector": result.receipt.invocation.visibleSelector,
    "v4-consumer-policy-scanner-root": result.receipt.policy.scannerRoot,
  };
}
