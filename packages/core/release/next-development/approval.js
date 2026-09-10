import { REVIEWER } from "./review-policy.js";
import { observe } from "./observation.js";
export async function approveNextDevelopment({ client, reviewer, plan }) {
  if (plan.schema !== "buildchain.next-development-review/v1")
    throw new Error("missing verified next-development plan");
  const { pull } = observe(client, plan.repository, plan.runId, plan);
  const identity = reviewer.json("user");
  if (identity.login !== REVIEWER || identity.login === pull.user?.login)
    throw new Error(
      "next-development requires the independent CODEOWNER identity",
    );
  const endpoint = `repos/${plan.repository}/pulls/${plan.number}/reviews`;
  const approved = (review) =>
    review.user?.login === REVIEWER &&
    review.commit_id === plan.headSha &&
    review.state === "APPROVED";
  const reviews = client.pages(endpoint);
  const latest = reviews
    .filter(
      (review) =>
        review.user?.login === REVIEWER &&
        ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state),
    )
    .at(-1);
  if (latest?.state === "CHANGES_REQUESTED")
    throw new Error(
      "independent reviewer requested changes; automation cannot override it",
    );
  if (!latest || !approved(latest)) {
    observe(client, plan.repository, plan.runId, plan);
    await reviewer.post(endpoint, {
      event: "APPROVE",
      commit_id: plan.headSha,
      body: `Verified the exact version-only transition by regenerating all tracked bytes from protected base ${plan.baseSha}. Publication binding: ${plan.publicationReceiptRoot || plan.publicationSourceSha}. Verification run: https://github.com/${plan.repository}/actions/runs/${plan.runId}.`,
    });
  }
  observe(client, plan.repository, plan.runId, plan);
  const readback = client.pages(endpoint).filter(approved).at(-1);
  if (!readback)
    throw new Error("independent exact-head approval readback failed");
  return { ...plan, reviewId: readback.id, reviewUrl: readback.html_url };
}

export function requireCurrentIndependentApproval(reviews, plan) {
  const latest = reviews
    .filter(
      (review) =>
        review.user?.login === REVIEWER &&
        ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state),
    )
    .at(-1);
  if (
    !latest ||
    latest.state !== "APPROVED" ||
    latest.commit_id !== plan.headSha ||
    latest.id !== plan.reviewId
  )
    throw new Error("independent approval no longer qualifies enqueue");
}
