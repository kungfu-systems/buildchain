const { SHA, assert, assertChannelPromotionPr, test } = await import(
  "./promote-buildchain-ref-recovery-harness.mjs"
);

function alphaRecoveryPullRequest(headRef) {
  return {
    merged_at: "2026-08-28T00:00:00Z",
    base: { ref: "alpha/v4/v4.0" },
    head: {
      ref: headRef,
      repo: { full_name: "kungfu-systems/buildchain" },
    },
  };
}

function admissionFor(headRef) {
  return assertChannelPromotionPr({
    octokit: {
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: async () => ({
            data: [alphaRecoveryPullRequest(headRef)],
          }),
        },
      },
    },
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v4/v4.0",
  });
}

test("alpha channel admission accepts its exact line-scoped recovery PR", async () => {
  const headRef = "fix/alpha-line-v4-v4.0-wave4-promotion-recovery";
  const pullRequest = await admissionFor(headRef);
  assert.equal(pullRequest.head.ref, headRef);
});

test("alpha channel admission rejects a recovery PR for another line", async () => {
  await assert.rejects(
    admissionFor("fix/alpha-line-v4-v4.1-wave4-promotion-recovery"),
    /exact line-scoped channel recovery PR/,
  );
});
