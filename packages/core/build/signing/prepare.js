import path from "node:path";
import { artifactNames } from "../artifact/contracts.js";
import { sealArtifactSigningRequests } from "./seal-requests.js";
import { sealArtifactSigningControlRequest } from "./request.js";
export async function sealSigning(plan, platform, sourceRoot) {
  const names = artifactNames(plan, platform);
  const requestRoot = `.buildchain/signing/requests/${platform.id}`;
  const index = sealArtifactSigningRequests({
    workspace: sourceRoot,
    cwd: plan.project.cwd,
    manifestPath: `.buildchain/artifacts/${platform.id}/manifest-build.json`,
    outputRoot: requestRoot,
    repository: plan.run.repository,
    sourceSha: plan.source.sha,
    sourceTreeSha: plan.source.tree_sha,
    runtimeSha: plan.identity.sha,
    platformId: platform.id,
  });
  sealArtifactSigningControlRequest({
    outputPath: path.join(
      sourceRoot,
      `.buildchain/signing/control-requests/${platform.id}/request.json`,
    ),
    sourceRepository: plan.run.repository,
    sourceRunId: plan.run.id,
    sourceRunAttempt: plan.run.attempt,
    sourceSha: plan.source.sha,
    sourceTreeSha: plan.source.tree_sha,
    runtimeRepository: plan.identity.repository,
    runtimeRef: plan.identity.ref,
    runtimeSha: plan.identity.sha,
    platformId: platform.id,
    platformName: platform.name,
    requestCount: index.requests.length,
    requestArtifact: names.request,
    requestIndexPath: path.join(sourceRoot, requestRoot, "index.json"),
    authorityRepository: plan.identity.repository,
    resultArtifact: names.result,
    artifactName: names.payload,
    manifestArtifact: names.manifest,
    diagnosticsArtifact: names.diagnostics,
    workingDirectory: plan.project.cwd,
  });
}
