export function selfDogfoodReady({
  pullRequest,
  reviews,
  checks,
  candidateSha,
  number,
}) {
  if (
    pullRequest.number !== number ||
    pullRequest.state !== "open" ||
    pullRequest.head?.sha !== candidateSha ||
    pullRequest.head?.repo?.full_name !== "kungfu-systems/buildchain" ||
    pullRequest.base?.repo?.full_name !== "kungfu-systems/buildchain" ||
    pullRequest.base?.ref !== "dev/v4/v4.1"
  )
    return false;
  const latestReview = reviews
    .filter(
      (row) =>
        String(row.user?.login || "").toLowerCase() === "kungfu-origin" &&
        row.state !== "COMMENTED",
    )
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  const latestCheck = checks
    .filter(
      (row) =>
        row.name === "check" &&
        row.head_sha === candidateSha &&
        row.app?.slug === "github-actions",
    )
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  return (
    latestReview?.state === "APPROVED" &&
    latestReview.commit_id === candidateSha &&
    latestCheck?.status === "completed" &&
    latestCheck.conclusion === "success"
  );
}
export async function readSelfDogfoodReadiness({
  github,
  number,
  candidateSha,
}) {
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !/^[0-9a-f]{40}$/.test(candidateSha || "")
  )
    throw Error("Self-dogfood readiness requires exact review coordinates");
  const owner = "kungfu-systems",
    repo = "buildchain";
  const pullRequest = (
    await github.rest.pulls.get({ owner, repo, pull_number: number })
  ).data;
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  const checks = await github.paginate(github.rest.checks.listForRef, {
    owner,
    repo,
    ref: candidateSha,
    per_page: 100,
  });
  return selfDogfoodReady({
    pullRequest,
    reviews,
    checks,
    candidateSha,
    number,
  });
}
