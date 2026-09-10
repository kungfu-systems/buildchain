import fs from "node:fs";
import path from "node:path";
import { scanConsumerPolicy } from "../../consumer/policy-scan.js";
import { validatePackageManagerContract } from "../package-manager.js";
import {
  inspectRuntimeContract,
  assertRuntimeContractAccepted,
} from "../../contracts/runtime-contract-inspection.js";

export async function admitBuildSource(
  { plan, sourceRoot, runtimeRoot, workspace, workflow },
  { reportIssue, summarize, warn },
) {
  const policy = scanConsumerPolicy({
    runtimeRoot,
    output: path.join(
      sourceRoot,
      ".buildchain/evidence/consumer-policy-receipt.json",
    ),
    root: sourceRoot,
    invocationRoot: sourceRoot,
    repository: plan.run.repository,
    sourceSha: plan.source.sha,
    invokedWorkflow: plan.identity.visible_workflow,
    invocationSourcePath: workflow.callerRef,
    expectedInvocationChannel: plan.identity.channel,
    resolvedWorkflowSha: plan.identity.sha,
    resolvedRuntimeSha: plan.identity.sha,
    stableLockPath: ".buildchain/contract-lock.json",
    alphaLockPath: ".buildchain/alpha-contract-lock.json",
  });
  if (!policy.ok)
    throw new Error("Build source rejected by floating consumer policy");
  validatePackageManagerContract({ cwd: sourceRoot, expectedManager: "" });
  const lock = inspectRuntimeContract({
    lockPath: path.join(sourceRoot, plan.contract.lock_path),
    currentContractPath: path.join(
      runtimeRoot,
      "dist/site/buildchain-contract.json",
    ),
    runtimeRoot,
    runtimeRef: plan.identity.ref,
    runtimeSha: plan.identity.sha,
    runtimeClass: plan.identity.channel,
    compatibilityPolicy: plan.build.contract.compatibility_policy,
    workflowShellRef: plan.identity.ref,
    expectedChannel: plan.identity.channel,
    expectedMajor: plan.identity.major,
    allowOpaqueRuntime: false,
    issueMode: plan.build.contract.drift_issue_mode,
    issueBodyPath: path.join(
      workspace,
      ".buildchain/contract-drift/issue-body.md",
    ),
    repository: plan.run.repository,
    workflow: workflow.name,
    runUrl: workflow.runUrl,
  });
  await summarize(lock.summary);
  const admission = {
    policy: policy.receipt,
    policy_root: policy.receiptRoot,
    contract_digest: lock.outputs["contract-digest"],
    lock_status: lock.outputs["contract-lock-status"],
  };
  if (lock.shouldIssue) {
    try {
      await reportIssue({
        targetRepository: plan.run.repository,
        title: `[Buildchain contract] ${plan.run.repository} drift on ${plan.identity.ref}`,
        summary: `Buildchain contract drift: ${admission.lock_status}`,
        failureCode: `buildchain-contract-${admission.lock_status}`,
        buildchainRef: plan.identity.ref,
        buildchainVersion: admission.contract_digest,
        consumerRepository: plan.run.repository,
        consumerRef: plan.source.ref,
        consumerSha: plan.source.sha,
        workflow: workflow.name,
        runId: plan.run.id,
        body: fs.readFileSync(
          lock.outputs["contract-lock-issue-body-file"],
          "utf8",
        ),
        labels: "buildchain-contract-drift",
        commentCooldownHours: 24,
      });
    } catch {
      warn("Contract drift report could not be submitted");
    }
  }
  assertRuntimeContractAccepted(lock);
  return admission;
}
