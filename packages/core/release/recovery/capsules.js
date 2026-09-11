import { domainContentRoot } from "../../contracts/canonical-contracts.js";
import { validateStageCapsule } from "../../build/stage-capsule.js";
import { runtimeResumeDocumentRoot } from "./lineage.js";
export function verifyReleaseCandidateStageCapsules({
  sidecar,
  passport,
  downloads,
}) {
  if (
    !sidecar ||
    sidecar.contract !==
      "kungfu-buildchain-v4-release-candidate-stage-capsules/v1" ||
    sidecar.status !== "sealed"
  ) {
    throw new Error(
      "cross-runtime recovery requires original sealed release-candidate Stage Capsules",
    );
  }
  const payload = { ...sidecar };
  delete payload.root;
  const expectedAttempt = `github-run:${passport.workflow.runId}:attempt:${passport.workflow.runAttempt}`;
  if (
    sidecar.root !== runtimeResumeDocumentRoot(payload) ||
    sidecar.repository !== passport.repository ||
    sidecar.source?.sha !== passport.source.headSha ||
    sidecar.source?.treeSha !== passport.source.treeHash ||
    sidecar.buildAttempt?.id !== expectedAttempt ||
    sidecar.consumerPolicyReceiptRoot !== passport.consumerPolicy?.receiptRoot
  ) {
    throw new Error(
      "release-candidate Stage Capsule sidecar identity mismatch",
    );
  }
  const artifactByName = new Map(
    downloads.map((entry) => [entry.artifact.name, entry]),
  );
  const required = [
    ...passport.platformMatrix.map((entry) => entry.platformId),
  ].sort();
  const entries = [...(sidecar.capsules || [])].sort((left, right) =>
    left.platform.localeCompare(right.platform),
  );
  if (
    entries.length !== required.length ||
    entries.some((entry, index) => entry.platform !== required[index])
  ) {
    throw new Error(
      "release-candidate Stage Capsule platform set is incomplete",
    );
  }
  return entries.map((entry) => {
    validateStageCapsule(entry.capsule);
    const download = artifactByName.get(entry.artifactName);
    const artifact = entry.artifact;
    if (
      !download ||
      artifact?.platformId !== entry.platform ||
      artifact?.id !== String(download.artifact.id) ||
      artifact?.name !== download.artifact.name ||
      artifact?.digest !== entry.artifactDigest ||
      artifact?.digest !== download.artifact.digest ||
      artifact?.digest !== download.record.digest ||
      artifact?.digest !== download.record.downloadedDigest ||
      artifact?.expiresAt !==
        new Date(download.artifact.expires_at).toISOString() ||
      entry.capsule.identity.policyRoot !== sidecar.consumerPolicyReceiptRoot ||
      entry.capsule.identity.sourceRoot !==
        domainContentRoot("candidate-identity", passport.source)
    ) {
      throw new Error(
        `Stage Capsule ${entry.platform} does not bind the verified provider artifact`,
      );
    }
    return {
      platform: entry.platform,
      capsuleRoot: entry.capsule.capsuleRoot,
      identityRoot: entry.capsule.identityRoot,
      artifactDigest: entry.artifactDigest,
      sourceSha: sidecar.source.sha,
      sourceTreeSha: sidecar.source.treeSha,
      policyRoot: sidecar.consumerPolicyReceiptRoot,
      buildRuntimeSha: sidecar.buildAttempt.runtimeSha,
      sealed: true,
    };
  });
}

export function resolveRecoveredStageCapsules({
  sidecar,
  passport,
  downloads,
}) {
  return verifyReleaseCandidateStageCapsules({ sidecar, passport, downloads });
}
