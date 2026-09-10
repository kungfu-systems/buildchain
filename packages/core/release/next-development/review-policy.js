import { FINALIZATION_BRANCH } from "./finalization.js";
export const REPOSITORY = "kungfu-systems/buildchain";
const WORKFLOW = ".github/workflows/self-build-verify.yml";
export const REVIEWER = "kungfu-origin";
const SHA = /^[a-f0-9]{40}$/u;
export const BRANCH =
  /^chore\/next-development\/((?:0|[1-9]\d*)\.\d+\.\d+-alpha\.\d+)-[a-f0-9]{16}$/u;

export function assertReviewRun(run, { repository, runId, headSha } = {}) {
  if (
    repository !== REPOSITORY ||
    run.repository?.full_name !== repository ||
    String(run.id) !== String(runId) ||
    run.path !== WORKFLOW ||
    run.name !== "Verify" ||
    run.event !== "pull_request" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !SHA.test(run.head_sha || "") ||
    !(
      BRANCH.test(run.head_branch || "") ||
      FINALIZATION_BRANCH.test(run.head_branch || "")
    ) ||
    (headSha && run.head_sha !== headSha)
  )
    throw new Error("unqualified next-development verification run");
}

export function assertReviewPull(
  pull,
  { repository, headSha, baseSha, branch },
) {
  const finalization = FINALIZATION_BRANCH.exec(branch || "");
  const expectedBase = finalization
    ? `release/v${finalization[1]}/v${finalization[1]}.${finalization[2]}`
    : `dev/v${BRANCH.exec(branch)?.[1].split(".")[0]}/v${BRANCH.exec(branch)?.[1].split(".").slice(0, 2).join(".")}`;
  if (
    repository !== REPOSITORY ||
    pull.head?.repo?.full_name !== repository ||
    pull.base?.repo?.full_name !== repository ||
    pull.head?.sha !== headSha ||
    pull.base?.sha !== baseSha ||
    pull.head?.ref !== branch ||
    !(BRANCH.test(branch || "") || finalization) ||
    pull.base?.ref !== expectedBase ||
    pull.state !== "open" ||
    pull.draft ||
    pull.merged_at ||
    !SHA.test(baseSha || "") ||
    !SHA.test(headSha || "") ||
    pull.user?.login === REVIEWER
  )
    throw new Error(
      "next-development review identity or protected base changed",
    );
}
