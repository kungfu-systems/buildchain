import { pipelineActionOutputs } from "./action-output.js";
import fs from "node:fs";
import path from "node:path";
import { normalInputs } from "../../consumer/contract/entries.js";
import { pipelineHost } from "./host.js";
import { controlPipeline } from "./controller.js";
import { buildPipelineSource } from "./build.js";
import { wakePipelineStableWait } from "../../publication/pipeline/stable-wait.js";

export async function controlPipelineAction(core, env) {
  const { configPath } = normalInputs({
    "config-path": core.getInput("config-path") || undefined,
  });
  const host = await pipelineHost(core, env, "Buildchain pipeline controller");
  const result = await controlPipeline(
    env.GITHUB_EVENT_NAME,
    JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
    { "config-path": configPath },
    host,
  );
  pipelineActionOutputs(core, result);
}

export async function buildPipelineAction(core, env) {
  const context = JSON.parse(core.getInput("context", { required: true }));
  const result = await buildPipelineSource({
    cwd: path.join(env.GITHUB_WORKSPACE, ".buildchain/product"),
    source: context.source,
    platform: core.getInput("platform", { required: true }),
    environment: env,
  });
  core.info(
    `Verified ${result.products.length} products on ${result.platform}`,
  );
}

export async function wakePipelineAction(core, env) {
  const waiting = core.getInput("stable-wait");
  const host = await pipelineHost(
    core,
    env,
    waiting ? "Recheck stable publication" : "Record delivery attempt",
  );
  if (waiting) {
    const wait = JSON.parse(waiting);
    if (wait.attempt !== core.getInput("attempt", { required: true }))
      throw new Error("Stable wake changed its exact business attempt");
    core.info(JSON.stringify(await wakePipelineStableWait(wait, host)));
    return;
  }
  await host.wake(core.getInput("attempt", { required: true }));
}
