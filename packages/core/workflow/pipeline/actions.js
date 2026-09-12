import fs from "node:fs";
import path from "node:path";
import { normalInputs } from "../../consumer/contract/entries.js";
import { pipelineHost } from "./host.js";
import { controlPipeline } from "./controller.js";
import { buildPipelineSource } from "./build.js";
import { recordPipelineBuild } from "./build-control.js";

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
  core.setOutput("operation", result.operation);
  core.setOutput("context", JSON.stringify(result.context || {}));
  core.setOutput(
    "matrix",
    JSON.stringify({ include: result.context?.platforms || [] }),
  );
  core.setOutput("request", JSON.stringify(result.request || {}));
  core.setOutput("attempt", result.attempt || result.context?.attempt || "");
  core.info(result.reason || result.operation);
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

export async function recordPipelineBuildAction(core, env) {
  const host = await pipelineHost(core, env, "Record product build");
  const context = JSON.parse(core.getInput("context", { required: true }));
  if (context.schema === "buildchain.pipeline-group-build-context/v1")
    return host.groupRecord(context);
  const result = await recordPipelineBuild(context, host);
  if (result.outcome !== "success")
    throw new Error("Product build did not succeed");
  core.info(
    result.wakePending
      ? "Build retained; next event will retry delivery wake"
      : "Build retained and attempt woken",
  );
}

export async function wakePipelineAction(core, env) {
  const host = await pipelineHost(core, env, "Record delivery attempt");
  await host.wake(core.getInput("attempt", { required: true }));
}
