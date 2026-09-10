import fs from "node:fs";
import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { installationRoot } from "../../runtime/installation-root.js";
import { executeAdmittedWorkflow } from "./execution.js";
import { providerExecutionContext } from "./provider-context.js";
export function candidateResultOutputs(value) {
  if (
    value.schema !== "kungfu-buildchain-v4-universal-workflow-result/v1" ||
    !["succeeded", "failed"].includes(value.status) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.resultRoot || "")
  )
    throw new Error("Candidate engine emitted an invalid result");
  return {
    "result-json": JSON.stringify(value),
    "result-root": value.resultRoot,
  };
}
export async function executeCandidateAction(core, env) {
  const runtimeRoot = installationRoot(import.meta.url);
  const engineSha = command("git", ["-C", runtimeRoot, "rev-parse", "HEAD"], {
    stdio: "pipe",
  }).trim();
  const result = await executeAdmittedWorkflow(
    JSON.parse(core.getInput("request-json", { required: true })),
    JSON.parse(core.getInput("admission-json", { required: true })),
    {
      runtimeRoot,
      engineSha,
      ...providerExecutionContext({
        token: core.getInput("token", { required: true }),
        mutationToken: core.getInput("mutation-token"),
        env,
      }),
    },
  );
  const output = path.join(env.GITHUB_WORKSPACE, ".buildchain/result.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result) + "\n");
  for (const [key, value] of Object.entries(candidateResultOutputs(result)))
    core.setOutput(key, value);
}
