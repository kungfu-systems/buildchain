import { reconcileConfiguredDevMergeQueue } from "../../dev-delivery/merge-queue-policy.js";
import { lineProtection } from "./protection.js";
import { assertLineApply } from "./request.js";
function verifyProtection(actual, expected) {
  const reviews = actual.required_pull_request_reviews || {},
    planned = expected.required_pull_request_reviews;
  const checks = actual.required_status_checks;
  if (
    actual.enforce_admins?.enabled !== expected.enforce_admins ||
    actual.required_conversation_resolution?.enabled !==
      expected.required_conversation_resolution ||
    checks?.strict !== expected.required_status_checks.strict ||
    JSON.stringify(
      (checks?.checks || [])
        .map(({ context, app_id }) => ({ context, app_id }))
        .sort((a, b) => a.context.localeCompare(b.context)),
    ) !== JSON.stringify(expected.required_status_checks.checks) ||
    [
      "dismiss_stale_reviews",
      "required_approving_review_count",
      "require_code_owner_reviews",
      "require_last_push_approval",
    ].some((key) => reviews[key] !== planned[key]) ||
    JSON.stringify(
      (reviews.bypass_pull_request_allowances?.apps || [])
        .map((app) => (typeof app === "string" ? app : app.slug))
        .sort(),
    ) !== JSON.stringify(planned.bypass_pull_request_allowances.apps) ||
    (reviews.bypass_pull_request_allowances?.users || []).length !== 0 ||
    (reviews.bypass_pull_request_allowances?.teams || []).length !== 0 ||
    actual.restrictions != null
  )
    throw new Error(
      "Release line branch protection did not read back as planned",
    );
}
export async function configureLineGovernance(
  { plan, repository, apply, devSha },
  { api, pullRequests, queue = reconcileConfiguredDevMergeQueue },
) {
  assertLineApply(apply);
  for (const channel of ["dev", "alpha", "release"]) {
    const endpoint = `repos/${repository}/branches/${encodeURIComponent(plan.refs[channel])}/protection`,
      protection = lineProtection(plan, channel);
    await api.request("PUT", endpoint, protection);
    verifyProtection(await api.json(endpoint), protection);
  }
  const queueResult = await queue({
    api,
    repository,
    branch: plan.refs.dev,
    cwd: plan.cwd,
    apply: true,
  });
  if (
    plan.repositoryActions.some(
      (action) => action.action === "set-default-branch",
    )
  ) {
    await api.request("PATCH", `repos/${repository}`, {
      default_branch: plan.refs.dev,
    });
    if (
      (await api.json(`repos/${repository}`)).default_branch !== plan.refs.dev
    )
      throw new Error("Release line default branch did not read back");
  }
  let alphaPr;
  if (
    plan.repositoryActions.some((action) => action.action === "open-alpha-pr")
  ) {
    const selection = { head: plan.refs.dev, base: plan.refs.alpha };
    let existing = await pullRequests.listOpen(selection);
    if (!Array.isArray(existing) || existing.length > 1)
      throw new Error("Ambiguous existing alpha PR");
    if (!existing.length) {
      await pullRequests.create({
        ...selection,
        title: `chore(release): promote ${plan.line} alpha`,
        body: `Buildchain release line bootstrap opened ${plan.line}. Merge this channel PR to publish the first alpha for the new minor line.`,
      });
      existing = await pullRequests.listOpen(selection);
    }
    if (
      existing.length !== 1 ||
      existing[0].head?.ref !== plan.refs.dev ||
      existing[0].head?.sha !== devSha ||
      existing[0].base?.ref !== plan.refs.alpha
    )
      throw new Error(
        "Release line alpha PR did not read back against exact source",
      );
    alphaPr = existing[0].number;
  }
  return { queue: queueResult, alphaPr };
}
