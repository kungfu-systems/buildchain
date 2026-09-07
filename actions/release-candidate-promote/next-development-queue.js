const MAX_POLLS = 480;
const MAX_TRANSPORT_RETRIES = 4;

export function nextDevelopmentQueueFailure(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const message = String(error?.message || "");
  if (/already.*queue|queue.*already/iu.test(message)) return "queued";
  if (/already.*merged|merged.*already/iu.test(message)) return "merged";
  if (
    /mergeability check has not yet completed|required status check .+ (?:expected|pending)|waiting on code owner review|at least \d+ approving review/iu.test(
      message,
    )
  )
    return "pending";
  if (
    [408, 429, 500, 502, 503, 504].includes(status) ||
    (status === 403 && /rate limit/iu.test(message)) ||
    /^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET)$/u.test(error?.code || "")
  )
    return "transient";
  return "rejected";
}

export function assertNextDevelopmentPull(pull, headSha, base) {
  if (pull.head?.sha !== headSha || (base && pull.base?.ref !== base))
    throw new Error("next-development exact pull request identity changed");
  if (pull.state === "closed" && !pull.merged_at)
    throw new Error("next-development pull request was closed without merge");
}

export async function enqueueNextDevelopmentPullRequest({
  mutationOctokit,
  pull,
  headSha,
  wait,
  maxPolls = MAX_POLLS,
}) {
  let transientRetries = 0;
  for (let poll = 0; poll <= maxPolls; poll += 1) {
    try {
      await mutationOctokit.graphql(
        `mutation BuildchainEnqueuePullRequest($input: EnqueuePullRequestInput!) {
          enqueuePullRequest(input: $input) { mergeQueueEntry { id } }
        }`,
        { input: { pullRequestId: pull.node_id, expectedHeadOid: headSha } },
      );
      return;
    } catch (error) {
      const kind = nextDevelopmentQueueFailure(error);
      if (kind === "queued" || kind === "merged") return;
      if (
        kind === "rejected" ||
        poll === maxPolls ||
        (kind === "transient" && transientRetries++ >= MAX_TRANSPORT_RETRIES)
      )
        throw Object.assign(error, {
          releaseTailClass: kind === "rejected" ? "conflict" : "transient",
        });
      // Pending mergeability is a bounded observation; permission and conflict failures never retry.
      await wait(Math.min(15_000, 2_000 * (poll + 1)));
    }
  }
}
