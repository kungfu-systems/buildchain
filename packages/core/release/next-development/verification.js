import { nextPatchDevelopmentVersion } from "../../publication/publication-development.js";
import { BRANCH } from "./review-policy.js";
import { observe } from "./observation.js";
import {
  FINALIZATION_BRANCH,
  verifyReleaseFinalization,
} from "./finalization.js";
export async function verifyNextDevelopmentReview({
  client,
  repository,
  runId,
  git,
  verifyDelta,
  publication,
}) {
  const { run, pull, baseSha } = observe(client, repository, runId);
  if (FINALIZATION_BRANCH.test(run.head_branch)) {
    git("fetch", "--no-tags", "origin", baseSha, run.head_sha);
    const plan = verifyReleaseFinalization({
      client,
      repository,
      run,
      pull,
      baseSha,
      git,
    });
    observe(client, repository, runId, plan);
    return plan;
  }
  if (git("rev-parse", "HEAD") !== baseSha)
    throw new Error(
      "review runtime is not the exact protected development base",
    );
  git("fetch", "--no-tags", "origin", run.head_sha);
  const parents = git("show", "-s", "--format=%P", run.head_sha).split(" ");
  if (parents.length !== 1 || parents[0] !== baseSha)
    throw new Error("next-development must have one exact protected parent");
  const version = JSON.parse(git("show", `${baseSha}:package.json`)).version;
  const targetVersion = BRANCH.exec(run.head_branch)[1];
  const stable = targetVersion.endsWith("-alpha.0");
  const completedStableVersion = version.split("-alpha.")[0];
  if (
    stable &&
    nextPatchDevelopmentVersion(completedStableVersion) !== targetVersion
  )
    throw new Error(
      "development target is not the completed stable patch successor",
    );
  const tag = `v${stable ? completedStableVersion : version}`;
  const sourceSha = client.json(`repos/${repository}/commits/${tag}`).sha;
  const settlement = await publication({ repository, tag, sourceSha });
  const publishedTree = settlement.documents.passport.source.treeHash;
  if (!stable && publishedTree !== git("rev-parse", `${baseSha}^{tree}`))
    throw new Error("development base is not the completed alpha source tree");
  if (
    stable &&
    (settlement.documents.passport.release?.version !==
      completedStableVersion ||
      settlement.documents.invocation?.target?.channel !== "stable")
  )
    throw new Error(
      "stable publication evidence differs from the completed version",
    );
  const projection = verifyDelta({
    baseSha,
    headSha: run.head_sha,
    ...(stable ? { completedStableVersion } : {}),
  });
  if (targetVersion !== projection.version)
    throw new Error(
      "next-development branch version differs from regenerated version",
    );
  observe(client, repository, runId, {
    headSha: run.head_sha,
    baseSha,
    number: pull.number,
  });
  return {
    schema: "buildchain.next-development-review/v1",
    repository,
    runId,
    number: pull.number,
    headSha: run.head_sha,
    baseSha,
    branch: run.head_branch,
    publicationReceiptRoot: settlement.documents.receipt.receiptRoot,
    projection,
  };
}
