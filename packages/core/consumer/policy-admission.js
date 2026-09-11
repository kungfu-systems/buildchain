import path from "node:path";
import { command } from "../runtime/action-process.mjs";
import { verifyCheckoutIdentity } from "../runtime/checkout-identity.js";
import { installationRoot } from "../runtime/installation-root.js";
import { scanConsumerPolicy, consumerPolicyOutputs } from "./policy-scan.js";
export function admitCheckedConsumerPolicy({
  runtimeRoot,
  consumerRoot,
  runtimeSha,
  consumerSha,
  repository,
  invokedWorkflow,
  invocationSourcePath,
  workflowSha = runtimeSha,
  invocationRoot = consumerRoot,
  definitionRepository,
  definitionSha,
  expectedInvocationChannel,
  stableLockPath = ".buildchain/contract-lock.json",
  alphaLockPath = ".buildchain/alpha-contract-lock.json",
}) {
  for (const [directory, expected] of [
    [consumerRoot, consumerSha],
  ]) {
    if (
      !/^[a-f0-9]{40}$/u.test(expected || "") ||
      command("git", ["-C", directory, "rev-parse", "HEAD"], {
        stdio: "pipe",
      }).trim() !== expected
    )
      throw new Error(
        "Consumer policy checkout differs from admitted immutable source",
      );
  }
  if (definitionSha)
    verifyCheckoutIdentity({
      directory: invocationRoot,
      sha: definitionSha,
      label: "Consumer workflow definition",
    });
  const output = path.join(
    consumerRoot,
    ".buildchain/evidence/consumer-policy-receipt.json",
  );
  const result = scanConsumerPolicy({
    runtimeRoot,
    root: consumerRoot,
    invocationRoot,
    definitionRepository,
    definitionSha,
    expectedInvocationChannel,
    repository,
    sourceSha: consumerSha,
    invokedWorkflow,
    invocationSourcePath,
    resolvedWorkflowSha: workflowSha,
    resolvedRuntimeSha: runtimeSha,
    stableLockPath,
    alphaLockPath,
    output,
  });
  return { result, output };
}
export function admitCheckedConsumerPolicyAction(core, env) {
  const { result, output } = admitCheckedConsumerPolicy({
    runtimeRoot: installationRoot(import.meta.url),
    consumerRoot: path.resolve(
      env.GITHUB_WORKSPACE,
      core.getInput("directory", { required: true }),
    ),
    runtimeSha:
      env.BUILDCHAIN_RUNTIME_SHA,
    workflowSha: core.getInput("workflow-sha", { required: true }),
    consumerSha: core.getInput("source-sha") || env.GITHUB_SHA,
    invocationRoot: core.getInput("invocation-directory")
      ? path.resolve(
          env.GITHUB_WORKSPACE,
          core.getInput("invocation-directory"),
        )
      : undefined,
    definitionRepository: core.getInput("definition-repository"),
    definitionSha: core.getInput("definition-sha"),
    expectedInvocationChannel: core.getInput("expected-channel"),
    stableLockPath:
      core.getInput("stable-lock-path") || ".buildchain/contract-lock.json",
    alphaLockPath:
      core.getInput("alpha-lock-path") ||
      ".buildchain/alpha-contract-lock.json",
    repository: env.GITHUB_REPOSITORY,
    invokedWorkflow: core.getInput("workflow", { required: true }),
    invocationSourcePath: env.GITHUB_WORKFLOW_REF,
  });
  for (const [name, value] of Object.entries(
    consumerPolicyOutputs(result, output),
  ))
    core.setOutput(name, value);
  if (!result.ok)
    throw new Error(
      "Consumer does not satisfy the current floating invocation policy",
    );
}
