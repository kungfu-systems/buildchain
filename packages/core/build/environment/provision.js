import path from "node:path";
import { lockedSourceCheckout } from "../../providers/source-checkout/transaction.js";
import { createRunnerEvidence } from "../../providers/commands/aws-runner-burst-core.mjs";
import { createWindowsJitEvidence } from "../../providers/commands/aws-windows-jit-core.mjs";
import { createMacosJitEvidence } from "../../providers/commands/aws-macos-jit-core.mjs";
import { prepareAwsCodeBuildToolchain } from "../../providers/toolchain/codebuild.js";
import { writeJson } from "../plan/values.js";

export function provisionBuildEnvironment({
  plan,
  platform,
  workspace,
  sourceRoot,
  tools,
  token,
  environment,
  observation,
  runnerTemp,
  home,
}) {
  const checkout = plan.environment.checkout;
  const evidence = lockedSourceCheckout({
    workspace,
    checkoutPath: sourceRoot,
    repository: plan.run.repository,
    sourceSha: plan.source.sha,
    sourceTreeSha: plan.source.tree_sha,
    fetchRef: plan.source.ref,
    historyMode: checkout.history_mode,
    mode: checkout.mode,
    mirrorUrlTemplate: checkout.mirror_url_template,
    referenceRepositoryTemplate: checkout.reference_repository_template,
    fallback: checkout.fallback,
    timeoutSeconds: checkout.timeout_seconds,
    githubTimeoutSeconds: checkout.github_timeout_seconds,
    fetchAttempts: checkout.fetch_attempts,
    diagnosticsPath: path.join(
      sourceRoot,
      ".buildchain/diagnostics/source-checkout.json",
    ),
    githubToken: token,
    environment,
  });
  if (!platform || !tools) return { checkout: evidence, paths: [] };
  const evidenceRoot = path.join(
    sourceRoot,
    `.buildchain/artifacts/${platform.id}`,
  );
  const paths = [];
  const common = {
    repository: plan.run.repository,
    sourceSha: plan.source.sha,
    sourceRef: plan.source.ref,
    githubRunId: plan.run.id,
    githubRunAttempt: plan.run.attempt,
    githubJob: observation.job,
    runnerName: observation.name,
    runnerLabels: observation.labels,
    instanceId: observation.ec2.instanceId,
    instanceType: observation.ec2.instanceType,
    amiId: observation.ec2.amiId,
    amiName: observation.ec2.amiName,
    availabilityZone: observation.ec2.availabilityZone,
    runnerStartedAt: observation.ec2.runnerStartedAt,
    runnerExitedAt: observation.ec2.runnerExitedAt,
    cacheMode: checkout.mode,
  };
  if (platform.provider === "aws-codebuild") {
    const runner = createRunnerEvidence({
      provider: platform.provider,
      project: platform.project,
      repository: plan.run.repository,
      sourceSha: plan.source.sha,
      sourceRef: plan.source.ref,
      runId: plan.run.id,
      runAttempt: plan.run.attempt,
      job: observation.job,
      codeBuildBuildId: observation.codebuild.buildId,
      codeBuildBuildArn: observation.codebuild.buildArn,
      codeBuildInitiator: observation.codebuild.initiator,
      region: observation.codebuild.region,
    });
    writeJson(path.join(evidenceRoot, "aws-runner-burst.json"), runner);
    const prepared = prepareAwsCodeBuildToolchain({
      runnerTemp,
      evidencePath: path.join(evidenceRoot, "aws-native-toolchain.json"),
      buildId: observation.codebuild.buildId,
      environment,
    });
    paths.push(...prepared.paths);
  }
  if (platform.provider === "aws-ec2-windows-jit")
    writeJson(
      path.join(evidenceRoot, "aws-windows-jit.json"),
      createWindowsJitEvidence({
        ...common,
        campaignId: observation.ec2.campaignId,
        launchedAt: observation.ec2.launchedAt,
        terminatedAt: observation.ec2.terminatedAt,
        cleanupResult: observation.ec2.cleanupResult,
      }),
    );
  if (platform.provider === "aws-ec2-macos-jit")
    writeJson(
      path.join(evidenceRoot, "aws-macos-jit.json"),
      createMacosJitEvidence({
        ...common,
        hostId: observation.ec2.hostId,
        hostAllocatedAt: observation.ec2.hostAllocatedAt,
        instanceLaunchedAt: observation.ec2.launchedAt,
      }),
    );
  return {
    checkout: evidence,
    paths: [
      ...paths,
      path.join(home, ".local/bin"),
      path.join(home, ".cargo/bin"),
    ],
  };
}
