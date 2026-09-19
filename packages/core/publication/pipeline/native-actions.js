import path from "node:path";
import { pipelineHost } from "../../workflow/pipeline/host.js";
import { githubJsonClient } from "../../providers/github/json-client.js";
import { controlPipelineNativeSigning } from "./native-control.js";
import { finalizeControlledPipelineProducts } from "./native-publish.js";

export function pipelineSigningHost(core) {
  const token = core.getInput("authority-token", { required: true });
  return {
    token,
    request: githubJsonClient({
      token,
      userAgent: "buildchain-native-publication",
    }),
  };
}

export async function controlPipelineNativeAction(core, env) {
  const host = await pipelineHost(core, env, "Control native signing");
  const context = JSON.parse(core.getInput("context", { required: true }));
  return controlPipelineNativeSigning(
    context,
    host,
    path.join(env.GITHUB_WORKSPACE, ".buildchain/native-controller"),
    pipelineSigningHost(core),
  );
}

export async function finalizePipelineNativeAction(core, env) {
  const platform = core.getInput("platform", { required: true });
  const host = await pipelineHost(
    core,
    env,
    `Finalize publication (${platform})`,
  );
  return finalizeControlledPipelineProducts({
    context: JSON.parse(core.getInput("context", { required: true })),
    host,
    platform,
    directory: path.join(env.GITHUB_WORKSPACE, ".buildchain/native-finalizer"),
    cwd: path.join(env.GITHUB_WORKSPACE, ".buildchain/product"),
    environment: env,
  });
}
