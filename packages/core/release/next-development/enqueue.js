import { requireCurrentIndependentApproval } from "./approval.js";
import { REVIEWER } from "./review-policy.js";
import { observe } from "./observation.js";
import { enqueueNextDevelopmentPullRequest } from "../promote-candidate/next-development-queue.js";
export async function enqueueVerifiedDevelopmentReview({
  client,
  repository,
  runId,
  plan,
  mergeFinalization,
}) {
  if (
    plan.schema !== "buildchain.next-development-review/v1" ||
    plan.repository !== repository ||
    String(plan.runId) !== String(runId) ||
    !plan.reviewId
  )
    throw new Error(
      "exact independent review readback required before enqueue",
    );
  const { pull } = observe(client, repository, runId, plan);
  const reviews = client.pages(
    `repos/${repository}/pulls/${plan.number}/reviews`,
  );
  requireCurrentIndependentApproval(reviews, plan);
  if (plan.kind === "stable-finalization") {
    // The CLI merges ready/UNSTABLE heads or enables auto-merge while blocked.
    await mergeFinalization({
      repository,
      number: pull.number,
      headSha: plan.headSha,
    });
    return;
  }
  await enqueueNextDevelopmentPullRequest({
    pull,
    headSha: plan.headSha,
    mutationOctokit: {
      graphql: async (query, variables) => {
        const result = client.post("graphql", { query, variables });
        if (result.errors?.length)
          throw new Error(
            result.errors.map((error) => error.message).join("; "),
          );
        return result.data;
      },
    },
    wait: (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
    maxPolls: 20,
  });
}
