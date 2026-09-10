import { readBuildActionContext } from "../plan/action-context.js";
import { command } from "../../runtime/action-process.mjs";
import { createBuildArtifactServices } from "./services.js";
export function buildArtifactActionContext(core, env) {
  const context = readBuildActionContext(core, env);
  const { workspace } = context;
  const token = core.getInput("token", { required: true });
  const services = createBuildArtifactServices(context, {
    token,
    awsCredentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
    },
    verifyAttestation: (args) =>
      command("gh", args, {
        cwd: workspace,
        env: { ...env, GH_TOKEN: token, GITHUB_TOKEN: token },
      }),
  });
  return { ...context, services };
}

export async function retainBuildArtifactAction(core, env) {
  const { platform, services } = buildArtifactActionContext(core, env);
  if (!platform)
    throw new Error("Build artifact retention requires a declared platform");
  core.setOutput("artifact", await services.transferBuild(platform));
}
export async function prepareBuildAttestationAction(core, env) {
  const { services } = buildArtifactActionContext(core, env);
  for (const [key, value] of Object.entries(
    await services.prepareAttestation(),
  ))
    core.setOutput(key, value);
}
export async function verifyBuildAttestationAction(core, env) {
  const { services } = buildArtifactActionContext(core, env);
  core.setOutput(
    "artifact",
    await services.finalizeAttestation({
      bundle: core.getInput("bundle-path", { required: true }),
      id: core.getInput("attestation-id", { required: true }),
      url: core.getInput("attestation-url", { required: true }),
    }),
  );
}
