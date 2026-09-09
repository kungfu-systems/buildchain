import fs from "node:fs";
import { command, requireValue } from "../../runtime/action-process.mjs";

function exactTime(value) {
  const time = new Date(value);
  requireValue(Number.isFinite(time.getTime()), "Review timestamp is invalid");
  return time.toISOString();
}
export function bootstrapVersionLine() {
  const version = JSON.parse(
    fs.readFileSync(
      new URL("../../../../package.json", import.meta.url),
      "utf8",
    ),
  ).version;
  const match = /^(\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?$/u.exec(version);
  requireValue(
    match,
    "Bootstrap package version must declare its release line",
  );
  return {
    development: `dev/v${match[1]}/v${match[1]}.${match[2]}`,
    alpha: `alpha/v${match[1]}/v${match[1]}.${match[2]}`,
  };
}
export function reviewedCandidateEvidence({
  request,
  pr,
  reviews,
  checks,
  commit,
  line,
  observedAt,
}) {
  const candidate = request.candidate;
  const matches =
    pr.head?.repo?.full_name === candidate.repository &&
    pr.number === candidate.reviewPullRequest;
  let kind;
  if (
    matches &&
    pr.head.sha === candidate.expectedSha &&
    pr.base?.ref === line.development
  )
    kind = "reviewed-head";
  else if (
    matches &&
    request.mode === "alpha" &&
    pr.merged === true &&
    pr.merge_commit_sha === candidate.expectedSha &&
    pr.base?.ref === line.alpha
  )
    kind = "protected-alpha-merge";
  requireValue(kind, "review does not bind the exact candidate runtime");
  const reviewedSha = pr.head.sha.toLowerCase();
  const latestReviews = new Map();
  for (const review of [...reviews].sort((a, b) => Date.parse(exactTime(a.submitted_at)) - Date.parse(exactTime(b.submitted_at)))) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
      latestReviews.set(review.user?.login?.toLowerCase(), review);
  }
  const latestChecks = new Map();
  for (const check of [...checks].sort((a, b) => (a.id || 0) - (b.id || 0))) {
    if (check.head_sha) requireValue(check.head_sha === candidate.expectedSha, "Check belongs to a different candidate");
    latestChecks.set(check.name, check);
  }
  reviews = [...latestReviews.values()];
  checks = [...latestChecks.values()];
  requireValue(
    reviews.some(
      (review) =>
        review.state === "APPROVED" &&
        review.commit_id === reviewedSha &&
        review.user?.login?.toLowerCase() === "kungfu-origin",
    ),
    "Exact candidate requires independent kungfu-origin approval",
  );
  requireValue(
    checks.some(
      (check) =>
        check.name === "check" &&
        check.status === "completed" &&
        check.conclusion === "success",
    ),
    "Exact candidate requires successful check",
  );
  return {
    repository: candidate.repository,
    pullRequest: candidate.reviewPullRequest,
    headSha: reviewedSha,
    baseRef: pr.base.ref,
    approvals: reviews
      .filter(
        (review) =>
          review.state === "APPROVED" && review.commit_id === reviewedSha,
      )
      .map((review) => ({
        reviewer: review.user.login.toLowerCase(),
        commitSha: review.commit_id,
        submittedAt: exactTime(review.submitted_at),
      })),
    checks: checks
      .filter((check) => check.status === "completed" && check.conclusion)
      .map(({ name, status, conclusion }) => ({
        name,
        status,
        conclusion,
        commitSha: candidate.expectedSha,
      })),
    runtimeBinding: {
      kind,
      runtimeSha: candidate.expectedSha,
      parentShas: commit.parents.map(({ sha }) => sha.toLowerCase()),
      mergedAt:
        kind === "protected-alpha-merge" ? exactTime(pr.merged_at) : null,
    },
    observedAt: exactTime(observedAt),
  };
}
export function readCandidateReview(request) {
  const { repository, expectedSha, reviewPullRequest } = request.candidate;
  const observed = command(
    "git",
    ["-C", ".buildchain/candidate", "rev-parse", "HEAD"],
    { stdio: ["ignore", "pipe", "inherit"] },
  )
    .trim()
    .toLowerCase();
  requireValue(
    observed === expectedSha,
    "Candidate checkout does not match its expected SHA",
  );
  const api = (endpoint, paginate = false) =>
    JSON.parse(
      command(
        "gh",
        [
          "api",
          ...(paginate ? ["--paginate", "--slurp"] : []),
          "-H",
          "Accept: application/vnd.github+json",
          `repos/${repository}/${endpoint}`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      ),
    );
  const pr = api(`pulls/${reviewPullRequest}`);
  const reviews = api(`pulls/${reviewPullRequest}/reviews`, true).flat();
  const checks = api(
    `commits/${expectedSha}/check-runs?per_page=100`,
    true,
  ).flatMap((page) => page.check_runs);
  const commit = api(`git/commits/${expectedSha}`);
  fs.mkdirSync(".buildchain", { recursive: true });
  for (const [name, value] of Object.entries({
    pr,
    reviews,
    checks,
    "runtime-commit": commit,
  }))
    fs.writeFileSync(`.buildchain/${name}.json`, JSON.stringify(value) + "\n");
  return reviewedCandidateEvidence({
    request,
    pr,
    reviews,
    checks,
    commit,
    line: bootstrapVersionLine(),
    observedAt: new Date().toISOString(),
  });
}
