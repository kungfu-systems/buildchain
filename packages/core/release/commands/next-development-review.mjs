import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPOSITORY } from "../next-development/review-policy.js";
import { verifyNextDevelopmentReview } from "../next-development/verification.js";
import { approveNextDevelopment } from "../next-development/approval.js";
import { enqueueVerifiedDevelopmentReview } from "../next-development/enqueue.js";
import { verifyVersionStateDelta } from "../version-state/verification.js";
import { readBinaryPublicationEvidence } from "../../publication/binary/evidence.js";
import { releaseAssetClient } from "../../providers/github/release-assets.js";
import { createGitHubCliApi } from "../../providers/github-cli-api.js";
async function main(mode) {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.VERIFY_RUN_ID;
  if (!/^\d+$/u.test(runId || "") || repository !== REPOSITORY)
    throw new Error("exact repository and verification run required");
  const client = createGitHubCliApi(undefined, { ...process.env, GH_TOKEN: process.env.GH_TOKEN });
  const file = ".buildchain/next-development-review.json";
  if (mode === "verify") {
    if (process.env.BUILDCHAIN_APPROVAL_TOKEN)
      throw new Error("verification must not receive the approval credential");
    const git = (...args) =>
      execFileSync("git", args, {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const plan = await verifyNextDevelopmentReview({
      client,
      repository,
      runId,
      git,
      verifyDelta: verifyVersionStateDelta,
      publication: (args) =>
        readBinaryPublicationEvidence({
          ...args,
          client: releaseAssetClient(repository, { token: process.env.GH_TOKEN }),
          attempts: 1,
        }),
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
  } else if (mode === "approve") {
    if (!process.env.BUILDCHAIN_APPROVAL_TOKEN)
      throw new Error("independent approval credential missing");
    const plan = JSON.parse(fs.readFileSync(file));
    if (plan.repository !== repository || String(plan.runId) !== runId)
      throw new Error("review plan is from another invocation");
    const result = await approveNextDevelopment({
      client,
      plan,
      reviewer: createGitHubCliApi(undefined, { ...process.env, GH_TOKEN: process.env.BUILDCHAIN_APPROVAL_TOKEN }),
    });
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      JSON.stringify({ reviewId: result.reviewId, headSha: result.headSha }),
    );
  } else if (mode === "enqueue") {
    const plan = JSON.parse(fs.readFileSync(file));
    if (
      plan.repository !== repository ||
      String(plan.runId) !== runId ||
      !plan.reviewId
    )
      throw new Error(
        "exact independent review readback required before enqueue",
      );
    await enqueueVerifiedDevelopmentReview({ client, repository, runId, plan, mergeFinalization: ({ repository, number, headSha }) => execFileSync("gh", ["pr", "merge", String(number), "--repo", repository, "--merge", "--auto", "--match-head-commit", headSha], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) });
  } else throw new Error("expected verify, approve or enqueue");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
