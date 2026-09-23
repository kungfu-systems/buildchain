import { runtimeContractLockDrift } from "../../contracts/runtime-contract-inspection.js";
import fs from "node:fs";
import path from "node:path";
import { containedBuildPath } from "../build-configuration.js";
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
    stableLockPath: plan.contract.stable_lock_path || ".buildchain/contract-lock.json",
    alphaLockPath: plan.contract.alpha_lock_path || ".buildchain/alpha-contract-lock.json",
  });
  if (!policy.ok) throw new Error("Build source rejected by floating consumer policy");
  validatePackageManagerContract({ cwd: sourceRoot, expectedManager: "" });
  const contract = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "dist/site/buildchain-contract.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(containedBuildPath(sourceRoot, plan.contract.lock_path), "utf8"));
  const lockDrift = runtimeContractLockDrift(lock, plan.identity.sha, contract.contractDigest);
  return { policy: policy.receipt, policy_root: policy.receiptRoot, contract_digest: contract.contractDigest,
    lock_status: plan.runtime?.origin || "contract-lock", lock_drift: lockDrift };

}
