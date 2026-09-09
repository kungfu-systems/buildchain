function containedPublishedVersionState(context, state, version) {
  const transaction =
    state.containsPublishedMaterial &&
    ["published", "finalizing", "complete"].includes(
      context.advancedPublicationTransaction?.state || "",
    )
      ? context.advancedPublicationTransaction
      : undefined;
  if (!transaction) return undefined;
  if (transaction.version !== version || !context.advancedChannelSha) {
    throw new Error(
      `Recovered publication version state for ${version} is not bound to the advanced channel transaction`,
    );
  }
  const discovered = context.discoverVersionStateFiles(context.cwd);
  const files = discovered.files.map(({ path }) => path);
  if (context.requireVersionState && files.length === 0) {
    throw new Error("Strict promotion requires package version state");
  }
  context.updates.push({
    action: "existing-recovered-published-version-state",
    version,
    files,
    sha: context.advancedChannelSha,
  });
  return {
    transaction,
    releaseCommit: {
      action: "existing-recovered-published",
      files,
      releaseTreeAllowedPaths:
        context.versionVerificationAllowedPathsForPromotion(
          context.rule.channel,
          files,
        ),
      sha: context.advancedChannelSha,
      version,
    },
  };
}

function containedPublishedReleaseCandidateVersion(
  context,
  state,
  observedVersion,
) {
  if (
    !state.containsPublishedMaterial ||
    context.releaseCandidateValidation?.recoveredCandidate !== true
  ) {
    return observedVersion;
  }
  const candidateVersion = String(context.releaseCandidateVersion || "").trim();
  const candidateBase = candidateVersion.match(
    /^(\d+\.\d+\.\d+)-alpha\.\d+$/u,
  )?.[1];
  if (!candidateBase || candidateBase !== state.releaseVersion) {
    throw new Error(
      `Recovered publication candidate ${candidateVersion || "<missing>"} is not bound to release ${state.releaseVersion}`,
    );
  }
  return candidateVersion;
}

function containedPublishedGovernanceReleaseSha(transaction, fallbackSha) {
  if (!transaction) return fallbackSha;
  const releaseSha = String(transaction.release_sha || "").trim();
  if (!/^[0-9a-f]{40}$/u.test(releaseSha)) {
    throw new Error(
      "Contained published recovery omitted its immutable release commit",
    );
  }
  return releaseSha;
}

export {
  containedPublishedGovernanceReleaseSha,
  containedPublishedReleaseCandidateVersion,
  containedPublishedVersionState,
};
