import test from "node:test";
import assert from "node:assert/strict";
import { githubPipelinePolicy } from "../packages/core/providers/github/pipeline-policy.js";
import { identities } from "./helpers/business-attempt.mjs";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

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
    ref: { refUpdateRule: null },
    mergeQueue: null,
  };
  const branch = {
    name: f.intent.source.targetBranch,
    protection: {
      required_status_checks: {
        contexts: ["check"],
        checks: [{ context: "check", app_id: 77 }],
      },
    },
  };
  const ref = { sha: f.generation.baseCommit };
  const request = async (url, options) => {
    if (url === "/graphql") {
      if (options.body.query.includes("branchProtectionRule"))
        throw new Error("Resource not accessible by integration");
      if (options.body.variables.ref)
        return { data: { repository: structuredClone(branchPolicy) } };
      reads++;
      return { data: { repository: { pullRequest: structuredClone(pr) } } };
    }
    if (url.includes("/rules/branches/")) return rules;
    if (url.endsWith(`/branches/${encodeURIComponent(branch.name)}`))
      return structuredClone(branch);
    if (url.includes("/reviews?")) return reviews;
    if (url.includes("/check-runs?")) return { check_runs: checks };
    if (url.includes("/statuses?")) return [];
    if (url.includes("/git/ref/")) return { object: { sha: ref.sha } };
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
    branch,
    observe,
    request,
    ref,
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

test("merged recovery requalifies the protected head from exact integration evidence without weakening normal base fencing", async () => {
  const f = fixture();
  f.ref.sha = "9".repeat(40);
  await assert.rejects(f.observe(), /changed during readback/);
  const body = {
    schema: "buildchain.pipeline-integration-readback/v1",
    repository: f.current.intent.repository,
    sourceHead: f.current.generation.source.commit,
    branch: f.current.intent.source.targetBranch,
    pullRequest: f.current.intent.source.pullRequest,
    protectedHead: f.ref.sha,
  };
  const integration = { ...body, root: recordDigest(body) };
  const api = githubPipelinePolicy(f.request, f.current.intent.repository);
  const result = await api.observeMerged(
    f.current,
    { minimum_approvals: 2 },
    integration,
  );
  assert.equal(result.review, true);
  assert.equal(result.integratedHead, f.ref.sha);
  assert.equal(result.baseCommit, f.current.generation.baseCommit);
  await assert.rejects(
    api.observeMerged(
      f.current,
      { minimum_approvals: 2 },
      { ...integration, protectedHead: "8".repeat(40) },
    ),
    /exact protected integration/,
  );
  f.ref.sha = "7".repeat(40);
  await assert.rejects(
    api.observeMerged(f.current, { minimum_approvals: 2 }, integration),
    /changed during readback/,
  );
});

test("viewer-enforced classic rules retain check App identity without administrative queries", async () => {
  const f = fixture();
  f.rules.length = 0;
  f.branchPolicy.ref.refUpdateRule = {
    requiredApprovingReviewCount: 2,
    requiresCodeOwnerReviews: true,
    requiredStatusCheckContexts: ["check"],
  };
  f.branchPolicy.mergeQueue = { id: "QUEUE" };
  const result = await f.observe();
  assert.equal(result.review, true);
  assert.equal(result.checksPassing, true);
  f.checks[0].app.id = 88;
  assert.equal((await f.observe()).checksPassing, false);
  f.checks[0].app.id = 77;
  f.branchPolicy.ref.refUpdateRule.requiredApprovingReviewCount = 0;
  await assert.rejects(f.observe(), /enforce declared/);
});

test("missing check App metadata and incomplete viewer rule projection fail closed", async () => {
  const f = fixture();
  const status = f.branch.protection.required_status_checks;
  delete status.checks[0].app_id;
  await assert.rejects(f.observe(), /check identity metadata is incomplete/);
  status.checks[0].app_id = 0;
  await assert.rejects(f.observe(), /check identity metadata is incomplete/);
  status.checks[0].app_id = 77;
  f.branchPolicy.ref.refUpdateRule = {
    requiredStatusCheckContexts: ["additional-check"],
  };
  await assert.rejects(f.observe(), /check identity metadata is incomplete/);
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
