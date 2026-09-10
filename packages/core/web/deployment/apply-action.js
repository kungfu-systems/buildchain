import { applyWebDeployment } from "./apply.js";

export async function webDeploymentAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  if (
    typeof request["working-directory"] !== "string" ||
    !request["working-directory"]
  )
    throw new Error("Web deployment requires a working directory");
  return applyWebDeployment(
    {
      workspace: env.GITHUB_WORKSPACE,
      channel: core.getInput("channel", { required: true }),
      workingDirectory: request["working-directory"],
      actor: env.GITHUB_ACTOR,
      runId: env.GITHUB_RUN_ID,
      healthPolicy: {
        allowedManagedNetworkRunner: ["true", "1"].includes(
          env.BUILDCHAIN_WEB_SURFACE_HEALTH_ALLOWED_RUNNER,
        ),
        managedNetworkS3ObjectVerification: !["false", "0"].includes(
          env.BUILDCHAIN_WEB_SURFACE_HEALTH_S3_OBJECTS,
        ),
      },
    },
    (values) => {
      for (const [key, value] of Object.entries(values))
        core.setOutput(key, value);
    },
  );
}
