import { recordDigest } from "../../release/discussion/envelope.js";

const QUERY = `query PipelinePolicy($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id number headRefOid baseRefName isDraft reviewDecision author{login}}}}`;
const BRANCH_QUERY = `query PipelineBranchPolicy($owner:String!,$name:String!,$branch:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){refUpdateRule{requiredApprovingReviewCount requiresCodeOwnerReviews requiredStatusCheckContexts}}mergeQueue(branch:$branch){id}}}`;

async function classicPolicy(request, owner, name, branch) {
  // Read viewer-enforced rules and the ordinary Contents:read branch projection.
  // Administrative branchProtectionRule and /protection queries are not needed.
  const result = await request("/graphql", {
    method: "POST",
    body: {
      query: BRANCH_QUERY,
      variables: { owner, name, branch, ref: `refs/heads/${branch}` },
    },
  });
  const repository = result.data?.repository;
  if (!repository?.ref)
    throw new Error("Protected branch metadata is unavailable");
  const rule = repository.ref.refUpdateRule;
  const observed = await request(
    `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}`,
  );
  const status = observed.protection?.required_status_checks;
  const contexts = status?.contexts;
  const checks = status?.checks;
  if (
    observed.name !== branch ||
    !Array.isArray(contexts) ||
    !Array.isArray(checks) ||
    checks.some(
      (check) =>
        typeof check.context !== "string" ||
        !check.context ||
        !Object.hasOwn(check, "app_id") ||
        !(
          check.app_id === null ||
          check.app_id === -1 ||
          (Number.isSafeInteger(check.app_id) && check.app_id > 0)
        ),
    ) ||
    contexts.some(
      (context) => !checks.some((check) => check.context === context),
    ) ||
    checks.some((check) => !contexts.includes(check.context)) ||
    (rule?.requiredStatusCheckContexts || []).some(
      (context) => !contexts.includes(context),
    )
  )
    throw new Error("Protected branch check identity metadata is incomplete");
  return {
    required_merge_queue: Boolean(repository.mergeQueue?.id),
    required_pull_request_reviews:
      rule?.requiredApprovingReviewCount > 0
        ? {
            require_code_owner_reviews: rule.requiresCodeOwnerReviews,
            required_approving_review_count: rule.requiredApprovingReviewCount,
          }
        : null,
    required_status_checks: {
      checks,
    },
  };
}

async function inventory(request, url, key = "") {
  const rows = [];
  for (let page = 1; page <= 100; page++) {
    const response = await request(
      `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    const entries = key ? response[key] : response;
    if (!Array.isArray(entries))
      throw new Error("Missing protected policy inventory");
    rows.push(...entries);
    if (entries.length < 100) return rows;
  }
  throw new Error("Protected policy inventory exceeds its bound");
}

function protections(rules, classic, policy) {
  const reviews = rules
    .filter((rule) => rule.type === "pull_request")
    .map((rule) => rule.parameters);
  if (classic?.required_pull_request_reviews)
    reviews.push({
      ...classic.required_pull_request_reviews,
      require_code_owner_review:
        classic.required_pull_request_reviews.require_code_owner_reviews,
    });
  if (
    !reviews.some((rule) => rule?.require_code_owner_review === true) ||
    !reviews.some(
      (rule) =>
        rule?.required_approving_review_count >= policy.minimum_approvals,
    ) ||
    !(
      classic?.required_merge_queue ||
      rules.some((rule) => rule.type === "merge_queue")
    )
  )
    throw new Error(
      "Protected branch must enforce declared approvals, code owners and merge queue",
    );
  const contexts = rules
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters?.required_status_checks || []);
  for (const check of classic?.required_status_checks?.checks || [])
    contexts.push({ context: check.context, integration_id: check.app_id });
  if (!contexts.length || contexts.some((check) => !check.context))
    throw new Error(
      "Protected pipeline requires provider-enforced status checks",
    );
  return contexts;
}

function approved(pr, reviews, minimum) {
  const latest = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (
      review.user?.login &&
      ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)
    )
      latest.set(review.user.login, review);
  }
  const independent = [...latest.values()].filter(
    (review) => review.user.login !== pr.author?.login,
  );
  return (
    pr.reviewDecision === "APPROVED" &&
    !independent.some((review) => review.state === "CHANGES_REQUESTED") &&
    independent.filter(
      (review) =>
        review.state === "APPROVED" && review.commit_id === pr.headRefOid,
    ).length >= minimum
  );
}

function checksPass(contexts, checks, statuses) {
  return contexts.every(({ context, integration_id: app }) => {
    const candidates = checks.filter(
      (check) =>
        check.name === context && (!app || app === -1 || check.app?.id === app),
    );
    const latest = candidates.sort((a, b) => b.id - a.id)[0];
    if (latest)
      return (
        latest.status === "completed" &&
        ["success", "neutral", "skipped"].includes(latest.conclusion)
      );
    if (app && app !== -1) return false;
    return (
      statuses
        .filter((status) => status.context === context)
        .sort((a, b) => b.id - a.id)[0]?.state === "success"
    );
  });
}

export function githubPipelinePolicy(request, repository) {
  const [owner, name] = repository.split("/");
  const base = `/repos/${repository}`;
  async function pull(number) {
    const response = await request("/graphql", {
      method: "POST",
      body: { query: QUERY, variables: { owner, name, number } },
    });
    const pr = response.data?.repository?.pullRequest;
    if (!pr?.id || pr.number !== number)
      throw new Error("Protected PR policy identity is unavailable");
    return pr;
  }
  async function observe(current, policy, integratedHead) {
    const { source, baseCommit } = current.generation;
    const number = current.intent.source.pullRequest,
      branch = current.intent.source.targetBranch;
    const pr = await pull(number);
    if (pr.headRefOid !== source.commit || pr.baseRefName !== branch)
      throw new Error("Protected PR policy source drift");
    const branchPath = encodeURIComponent(branch);
    const rules = await inventory(
      request,
      `${base}/rules/branches/${branchPath}`,
    );
    const classic = await classicPolicy(request, owner, name, branch);
    const contexts = protections(rules, classic, policy);
    const reviews = await inventory(request, `${base}/pulls/${number}/reviews`);
    const checks = await inventory(
      request,
      `${base}/commits/${source.commit}/check-runs?filter=latest`,
      "check_runs",
    );
    const statuses = await inventory(
      request,
      `${base}/commits/${source.commit}/statuses`,
    );
    const again = await pull(number);
    const ref = await request(`${base}/git/ref/heads/${branch}`);
    if (
      recordDigest(pr) !== recordDigest(again) ||
      ref.object?.sha !== (integratedHead || baseCommit)
    )
      throw new Error("Protected policy changed during readback");
    const body = {
      schema: "buildchain.pipeline-policy-readback/v1",
      source,
      baseCommit,
      pr,
      rules,
      classic: classic || null,
      reviews,
      checks,
      statuses,
      contexts,
      review: !pr.isDraft && approved(pr, reviews, policy.minimum_approvals),
      checksPassing: checksPass(contexts, checks, statuses),
      ...(integratedHead ? { integratedHead } : {}),
    };
    return { ...body, root: recordDigest(body) };
  }
  async function observeMerged(current, policy, integration) {
    const { root, ...body } = integration;
    if (
      root !== recordDigest(body) ||
      body.schema !== "buildchain.pipeline-integration-readback/v1" ||
      body.repository !== repository ||
      body.sourceHead !== current.generation.source.commit ||
      body.branch !== current.intent.source.targetBranch ||
      body.pullRequest !== current.intent.source.pullRequest ||
      !/^[0-9a-f]{40}$/u.test(body.protectedHead || "")
    )
      throw new Error(
        "Merged review qualification requires exact protected integration evidence",
      );
    return observe(current, policy, body.protectedHead);
  }
  return {
    observe: (current, policy) => observe(current, policy),
    observeMerged,
  };
}
