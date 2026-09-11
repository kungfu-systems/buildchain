import { resolveRunnerMatrix } from "../runner/matrix.js";
import { resolveOfflineRunnerFallback } from "../../providers/runner/offline-routing.js";
import { buildMatrices } from "./matrices.js";
import { resolveArtifactTransfer } from "../artifact/transfer-policy.js";

export async function resolveBuildRunners(plan, runnerInventory) {
  const configuration = plan.environment.runners;
  let runners = resolveRunnerMatrix({
    runnerPreset: configuration.preset,
    platformsJson: configuration.platforms_json,
    awsCodeBuildProject: configuration.codebuild_project,
    awsEc2WindowsRunnerLabel: configuration.windows_label,
    awsEc2MacosRunnerLabel: configuration.macos_label,
    linuxContainerPreset: configuration.container_preset,
    linuxContainerImage: configuration.container_image,
  });
  let routing;
  if (configuration.offline_fallback) {
    const fallback = await resolveOfflineRunnerFallback({
      runnerPreset: "custom",
      platformsJson: runners.platformsJson,
      repository: plan.run.repository,
      ...runnerInventory,
    });
    runners = resolveRunnerMatrix({
      runnerPreset: "custom",
      platformsJson: fallback.platformsJson,
      linuxContainerPreset: configuration.container_preset,
      linuxContainerImage: configuration.container_image,
    });
    routing = fallback.routing;
  }
  const transfer = plan.environment.transfer;
  return {
    ...buildMatrices(plan, runners),
    ...(routing ? { routing } : {}),
    transfer: resolveArtifactTransfer({
      mode: transfer.mode,
      relayRequired: runners.relayPlatformCount > 0,
      bucket: transfer.bucket,
      region: transfer.region,
      prefix: transfer.prefix,
      uploadRole: transfer.upload_role_arn,
      downloadRole: transfer.download_role_arn,
      oidcAudience: transfer.oidc_audience,
    }),
  };
}
