import { assertReviewRun, assertReviewPull } from "./review-policy.js";
export function observe(client, repository, runId, expected = {}) {
  const prefix = `repos/${repository}`;
  const run = client.json(`${prefix}/actions/runs/${runId}`);
  assertReviewRun(run, { repository, runId, headSha: expected.headSha });
  const associated = client.pages(`${prefix}/commits/${run.head_sha}/pulls`);
  const matches = associated.filter(
    (pull) =>
      pull.head?.sha === run.head_sha &&
      pull.head?.ref === run.head_branch &&
      pull.head?.repo?.full_name === repository &&
      pull.state === "open",
  );
  if (matches.length !== 1) throw new Error("ambiguous next-development PR");
  const pull = client.json(`${prefix}/pulls/${matches[0].number}`);
  const baseSha = client.json(`${prefix}/git/ref/heads/${pull.base.ref}`).object
    .sha;
  assertReviewPull(pull, {
    repository,
    headSha: run.head_sha,
    baseSha,
    branch: run.head_branch,
  });
  if (
    expected.baseSha &&
    (baseSha !== expected.baseSha || pull.number !== expected.number)
  )
    throw new Error("next-development review plan became stale");
  const checks = client.pages(
    `${prefix}/actions/runs/${runId}/jobs?filter=latest`,
    "jobs",
  );
  const check = checks.filter((job) => job.name === "check");
  if (
    check.length !== 1 ||
    check[0].status !== "completed" ||
    check[0].conclusion !== "success"
  )
    throw new Error("exact Verify check did not succeed");
  return { run, pull, baseSha };
}
