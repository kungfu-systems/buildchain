import { buildSigningConsumerEnvironment } from "./environment.js";
import path from "node:path";
import { buildArtifactActionContext } from "../artifact/actions.js";
import { command } from "../../runtime/action-process.mjs";
import { runLifecycle } from "../lifecycle/transaction.js";
import { dispatchArtifactSigningAuthority } from "./dispatch.js";
import { createBuildSigningService } from "./transaction.js";

function service(core, env) {
  const context = buildArtifactActionContext(core, env);
  if (!context.platform)
    throw new Error("Build signing requires a declared platform");
  const controlToken = core.getInput("control-token");
  return createBuildSigningService(
    {
      ...context,
      sourceRoot: path.join(context.workspace, "source"),
      controller: { job: env.GITHUB_JOB, runnerOs: env.RUNNER_OS },
      consumerEnvironment: buildSigningConsumerEnvironment(
        env,
        core.getInput("token", { required: true }),
      ),
    },
    {
      controlToken,
      dispatch: (request) =>
        dispatchArtifactSigningAuthority({ ...request, token: controlToken }),
      executeLifecycle: runLifecycle,
      executeConsumer: ({ command: script, cwd, env: environment }) =>
        command(
          process.platform === "win32" ? "pwsh" : "bash",
          process.platform === "win32"
            ? ["-NoProfile", "-NonInteractive", "-Command", script]
            : ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
          { cwd, env: environment },
        ),
    },
  );
}
export async function completeBuildSigningAction(core, env) {
  core.setOutput("artifact", await service(core, env).completeSigning());
}
export async function admitBuildCredentialAction(core, env) {
  core.setOutput(
    "bundle-id",
    (await service(core, env).prepareCredential()).bundleId,
  );
}
export async function retainBuildCredentialAction(core, env) {
  await service(core, env).publishCredential({
    manifestPath: core.getInput("manifest-path", { required: true }),
    artifactRoot: core.getInput("artifact-root", { required: true }),
  });
}
