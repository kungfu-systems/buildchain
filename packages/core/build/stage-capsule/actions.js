import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { installationRoot } from "../../runtime/installation-root.js";
import { exactWorkflowRuntime } from "../../runtime/workflow-runtime.js";
import { qualifyStageCapsuleConsumer } from "./canary.js";
import { aggregateStageCapsuleCampaign } from "./campaign/aggregate.js";
function runtime(core) {
  const runtimeRoot = installationRoot(import.meta.url);
  const runtimeSha = exactWorkflowRuntime(
    core.getInput("workflow-sha", { required: true }),
  );
  if (
    command("git", ["-C", runtimeRoot, "rev-parse", "HEAD"], {
      stdio: "pipe",
    }).trim() !== runtimeSha
  )
    throw new Error("Stage Capsule runtime differs from called workflow");
  return { runtimeRoot, runtimeSha };
}
export async function qualifyStageCapsuleConsumerAction(core, env) {
  const binding = runtime(core);
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  if (
    command("git", ["-C", workspace, "rev-parse", "HEAD"], {
      stdio: "pipe",
    }).trim() !== env.GITHUB_SHA
  )
    throw new Error("Stage Capsule consumer differs from invoked source");
  await qualifyStageCapsuleConsumer({
    ...binding,
    workspace,
    sourceSha: env.GITHUB_SHA,
    platform: core.getInput("platform", { required: true }),
    request: JSON.parse(core.getInput("request-json", { required: true })),
    environment: Object.fromEntries(
      Object.entries(env).filter(([key]) => !key.startsWith("INPUT_")),
    ),
  });
}
export function aggregateStageCapsuleConsumerAction(core, env) {
  runtime(core);
  return aggregateStageCapsuleCampaign({
    directory: path.join(
      env.GITHUB_WORKSPACE,
      ".buildchain/stage-capsule-canary-inputs",
    ),
    expectedConsumers: [core.getInput("consumer", { required: true })],
    output: path.join(
      env.GITHUB_WORKSPACE,
      ".buildchain/stage-capsule-canary-qualification.json",
    ),
  });
}
