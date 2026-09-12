import test from "node:test";
import assert from "node:assert/strict";
import { githubPipelinePolicy } from "../packages/core/providers/github/pipeline-policy.js";
import { identities } from "./helpers/business-attempt.mjs";

function fixture() {
  const f = identities();
  const current = { intent: f.intent, generation: f.generation };
  const pr = {
    id: "PR_23",
    number: 23,
    headRefOid: f.source.commit,
    baseRefName: f.intent.source.targetBranch,
    isDraft: false,
    reviewDecision: "APPROVED",
    author: { login: "author" },
  };
  const rules = [
    {
      type: "pull_request",
      parameters: {
        require_code_owner_review: true,
        required_approving_review_count: 2,
      },
    },
    { type: "merge_queue" },
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: [{ context: "check", integration_id: 77 }],
      },
    },
  ];
  const reviews = ["one", "two"].map((login, i) => ({
    id: i + 1,
    user: { login },
    commit_id: f.source.commit,
    state: "APPROVED",
  }));
  const checks = [
    {
      id: 9,
      name: "check",
      app: { id: 77 },
      status: "completed",
      conclusion: "success",
    },
  ];
  let reads = 0;
  const branchPolicy = {
    ref: { branchProtectionRule: null },
    mergeQueue: null,
  };
  const request = async (url, options) => {
    if (url === "/graphql") {
      if (options.body.variables.ref)
        return { data: { repository: structuredClone(branchPolicy) } };
      reads++;
      return { data: { repository: { pullRequest: structuredClone(pr) } } };
    }
    if (url.includes("/rules/branches/")) return rules;
    if (url.includes("/reviews?")) return reviews;
    if (url.includes("/check-runs?")) return { check_runs: checks };
    if (url.includes("/statuses?")) return [];
    if (url.includes("/git/ref/"))
      return { object: { sha: f.generation.baseCommit } };
    throw new Error(url);
  };
  const observe = () =>
    githubPipelinePolicy(request, f.intent.repository).observe(current, {
      minimum_approvals: 2,
    });
  return {
    current,
    pr,
    rules,
    reviews,
    checks,
    branchPolicy,
    observe,
    reads: () => reads,
  };
}

test("protected review needs independent exact-source approvals and provider-enforced owners and queue", async () => {
  const f = fixture();
  assert.equal((await f.observe()).review, true);
  assert.equal(f.reads(), 2);
  f.reviews[0].user.login = "author";
  assert.equal((await f.observe()).review, false);
  f.reviews[0].user.login = "one";
  f.reviews[0].commit_id = "e".repeat(40);
  assert.equal((await f.observe()).review, false);
  f.rules.splice(1, 1);
  await assert.rejects(f.observe(), /enforce declared/);
});

test("classic review and check protection uses readable GraphQL metadata without an administrative REST request", async () => {
  const f = fixture();
  f.rules.length = 0;
  f.branchPolicy.ref.branchProtectionRule = {
    requiresApprovingReviews: true,
    requiredApprovingReviewCount: 2,
    requiresCodeOwnerReviews: true,
    requiresStatusChecks: true,
    requiredStatusChecks: [{ context: "check", app: { databaseId: 77 } }],
  };
  f.branchPolicy.mergeQueue = { id: "QUEUE" };
  const result = await f.observe();
  assert.equal(result.review, true);
  assert.equal(result.checksPassing, true);
  f.branchPolicy.ref.branchProtectionRule.requiresApprovingReviews = false;
  await assert.rejects(f.observe(), /enforce declared/);
});

test("latest check is bound to required app and changes-requested cannot be counted as approval", async () => {
  const f = fixture();
  assert.equal((await f.observe()).checksPassing, true);
  f.checks[0].app.id = 88;
  assert.equal((await f.observe()).checksPassing, false);
  f.checks[0].app.id = 77;
  f.checks.push({ ...f.checks[0], id: 10, conclusion: "failure" });
  assert.equal((await f.observe()).checksPassing, false);
  f.reviews.push({ ...f.reviews[0], id: 3, state: "CHANGES_REQUESTED" });
  assert.equal((await f.observe()).review, false);
  f.pr.headRefOid = "d".repeat(40);
  await assert.rejects(f.observe(), /source drift/);
});
