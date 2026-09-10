import path from "node:path";
import { runLifecycle } from "../lifecycle/transaction.js";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";
import { createCampaignContext } from "./campaign/context.js";
import { runStageCapsuleCampaign } from "./campaign/run.js";
export async function qualifyStageCapsuleConsumer({
  workspace,
  runtimeRoot,
  runtimeSha,
  sourceSha,
  platform,
  request,
  environment,
}) {
  const evidenceRoot = path.join(
    workspace,
    ".buildchain/artifacts/stage-capsule-canary",
  );
  const session = consumerCommandSession({
    ...environment,
    BUILDCHAIN_SOURCE_SHA: sourceSha,
    BUILDCHAIN_NODE: process.execPath,
  });
  for (const stage of ["install", "build", "verify"]) {
    await session.phase(
      (env) =>
        runLifecycle({
          cwd: workspace,
          workspace,
          stageName: stage,
          required: true,
          platformId: platform,
          artifactName: `${request.consumer}-v4-canary-${stage}`,
          artifactPaths: [request[`${stage}-artifact-path`]],
          manifestPath: path.join(evidenceRoot, `${stage}-manifest.json`),
          summaryPath: path.join(evidenceRoot, `${stage}-summary.json`),
          env,
        }),
      {
        CANARY_CONSUMER: request.consumer,
        CANARY_PLATFORM: platform,
        CANARY_ARTIFACT_PATH: request[`${stage}-artifact-path`],
      },
    );
  }
  return runStageCapsuleCampaign(
    createCampaignContext({
      workRoot: path.join(
        workspace,
        ".buildchain/stage-capsule-canary",
        platform,
      ),
      platform,
      consumer: request.consumer,
      runtimeRef: runtimeSha,
      consumerSourceRevision: sourceSha,
      consumerRoot: workspace,
      runtimeRoot,
      lifecycleEvidenceRoot: evidenceRoot,
    }),
  );
}
