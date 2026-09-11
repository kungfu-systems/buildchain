import fs from "node:fs";
import path from "node:path";
import { scanConsumerPolicy } from "../../consumer/policy-scan.js";
import { validatePackageManagerContract } from "../package-manager.js";

export async function admitBuildSource({ plan, sourceRoot, runtimeRoot, workflow }) {
  const policy = scanConsumerPolicy({
    runtimeRoot,
    output: path.join(sourceRoot, ".buildchain/evidence/consumer-policy-receipt.json"),
    root: sourceRoot,
    invocationRoot: sourceRoot,
    repository: plan.run.repository,
    sourceSha: plan.source.sha,
    invokedWorkflow: plan.identity.visible_workflow,
    invocationSourcePath: workflow.callerRef,
    expectedInvocationChannel: plan.identity.channel,
    resolvedWorkflowSha: plan.entry.sha,
    resolvedRuntimeSha: plan.identity.sha,
    stableLockPath: ".buildchain/contract-lock.json",
    alphaLockPath: ".buildchain/alpha-contract-lock.json",
  });
  if (!policy.ok) throw new Error("Build source rejected by floating consumer policy");
  validatePackageManagerContract({ cwd: sourceRoot, expectedManager: "" });
  const contract = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "dist/site/buildchain-contract.json"), "utf8"));
  return { policy: policy.receipt, policy_root: policy.receiptRoot, contract_digest: contract.contractDigest, lock_status: plan.runtime?.origin || "contract-lock" };
}
