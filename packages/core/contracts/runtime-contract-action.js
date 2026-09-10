import fs from "node:fs";
import path from "node:path";
import {
  inspectRuntimeContract,
  assertRuntimeContractAccepted,
} from "./runtime-contract-inspection.js";
import { resolveBuildchainContractLockPath } from "./buildchain-layout.js";

export function runtimeContractAction(core, env) {
  const workspace = env.GITHUB_WORKSPACE;
  if (!path.isAbsolute(workspace || ""))
    throw new Error("Runtime contract check requires the runner workspace");
  const input = JSON.parse(core.getInput("request-json", { required: true }));
  const runtimeRoot = path.join(workspace, ".buildchain/runtime");
  const result = inspectRuntimeContract({
    lockPath: path.resolve(
      workspace,
      input["buildchain-contract-lock-path"] ||
        resolveBuildchainContractLockPath(workspace),
    ),
    currentContractPath: path.join(
      runtimeRoot,
      "dist/site/buildchain-contract.json",
    ),
    runtimeRoot,
    runtimeRef: core.getInput("runtime-ref"),
    runtimeSha: core.getInput("runtime-sha"),
    runtimeClass: core.getInput("runtime-class"),
    workflowShellRef: core.getInput("workflow-ref"),
    allowOpaqueRuntime: core.getBooleanInput("runtime-override"),
    compatibilityPolicy: input["buildchain-contract-compatibility-policy"],
    expectedChannel: input["buildchain-contract-expected-channel"],
    expectedMajor: input["buildchain-contract-expected-major"],
    issueMode: input["buildchain-contract-drift-issue-mode"],
    issueBodyPath: path.join(
      workspace,
      ".buildchain/contract-drift/issue-body.md",
    ),
    repository: env.GITHUB_REPOSITORY,
    workflow: env.GITHUB_WORKFLOW,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
  });
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, result.summary + "\n\n");
  for (const [key, value] of Object.entries(result.outputs))
    core.setOutput(key, value);
  assertRuntimeContractAccepted(result);
}
