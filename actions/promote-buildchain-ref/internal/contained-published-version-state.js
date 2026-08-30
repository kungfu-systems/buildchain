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

export { containedPublishedVersionState };
