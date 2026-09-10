import { resolveChannelCandidate } from "./lineage.js";
import { waitForCandidateArtifacts } from "./run-selection.js";
import { downloadCandidateArtifacts } from "./download.js";
import { materializeCandidateEvidence } from "./materialize.js";
import { splitRepository, normalizeBranch, assertSha } from "./selection.js";
import { selectPayloadArtifacts } from "./payloads.js";
export async function resolveReleaseCandidateArtifacts({
  repository,
  targetRef,
  targetSha,
  token = "",
  apiUrl = "https://api.github.com",
  workflowFile = "self-build-fixture.yml",
  workflowName = "Build Surface Fixture",
  artifactName = "",
  artifactPatterns = "",
  githubReleasePayloadPatterns = "",
  requiredArtifactCount = 0,
  publishArtifactKind = "npm",
  publishPackageMain = "",
  runtimeSha = "",
  outputDir = ".buildchain/release-candidate",
  fetchImpl = globalThis.fetch,
  download = true,
  waitSeconds = 600,
  pollIntervalMs = 15000,
  sleepImpl = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const repoInfo = splitRepository(repository);
  const sha = assertSha(targetSha, "targetSha");
  const normalizedTarget = normalizeBranch(targetRef);
  const releaseCandidateTarget = /^(alpha|release)\/v\d+\/v\d+\.\d+$/.test(
    normalizedTarget,
  );
  const majorGateTarget = normalizedTarget === "publish-gate/major";
  if (!releaseCandidateTarget && !majorGateTarget) {
    return {
      enabled: false,
      reason: `target ref ${normalizedTarget || "(empty)"} does not require release-candidate promotion`,
    };
  }
  const provider = { apiUrl, token, fetchImpl };
  const { channelPullRequest, pullRequest } = await resolveChannelCandidate({
    repoInfo,
    sha,
    normalizedTarget,
    majorGateTarget,
    ...provider,
  });
  const { run, artifactResponse, selected } = await waitForCandidateArtifacts({
    repoInfo,
    pullRequest,
    workflowFile,
    workflowName,
    artifactName,
    waitSeconds,
    pollIntervalMs,
    sleepImpl,
    ...provider,
  });
  const payloadArtifacts = selectPayloadArtifacts({
    artifacts: Array.isArray(artifactResponse.artifacts)
      ? artifactResponse.artifacts
      : [],
    artifactName: selected.prefix,
    sourceSha: selected.sourceSha,
    patterns: artifactPatterns,
  });
  const minimumPayloadCount = Number(requiredArtifactCount || 0);
  if (
    minimumPayloadCount > 0 &&
    payloadArtifacts.length < minimumPayloadCount
  ) {
    throw new Error(
      `expected at least ${minimumPayloadCount} PR-stage payload artifacts, found ${payloadArtifacts.length}`,
    );
  }
  const result = {
    enabled: true,
    repository: repoInfo.fullName,
    targetRef: normalizedTarget,
    targetSha: sha,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.html_url || pullRequest.url || "",
      headRef: pullRequest.head?.ref || "",
      baseRef: pullRequest.base?.ref || "",
    },
    ...(majorGateTarget
      ? {
          promotionPullRequest: {
            number: channelPullRequest.number,
            url: channelPullRequest.html_url || channelPullRequest.url || "",
            headRef: channelPullRequest.head?.ref || "",
            baseRef: channelPullRequest.base?.ref || "",
          },
        }
      : {}),
    run: {
      id: String(run.id || ""),
      url: run.html_url || run.url || "",
      name: run.name || workflowName,
    },
    artifacts: {
      passport: selected.passport.name,
      summary: selected.summary.name,
      payloads: payloadArtifacts.map((artifact) => artifact.name),
      artifactName: selected.prefix,
      sourceSha: selected.sourceSha,
    },
  };
  if (!download) {
    return result;
  }
  const directories = await downloadCandidateArtifacts({
    outputDir,
    repoInfo,
    selected,
    payloadArtifacts,
    ...provider,
  });
  return materializeCandidateEvidence({
    result,
    ...directories,
    payloadArtifacts,
    minimumPayloadCount,
    publishArtifactKind,
    publishPackageMain,
    githubReleasePayloadPatterns,
  });
}
