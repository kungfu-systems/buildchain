import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verifyVersionStateDelta } from "./verify-version-state-delta.mjs";
import { readBinaryPublicationEvidence } from "./binary-publication-evidence.mjs";
import { releaseAssetClient } from "./release-asset-client.mjs";
import { enqueueNextDevelopmentPullRequest } from "../actions/v4-release-candidate-promote/next-development-queue.js";

const REPOSITORY = "kungfu-systems/buildchain";
const WORKFLOW = ".github/workflows/self-build-verify.yml";
const REVIEWER = "kungfu-origin";
const SHA = /^[a-f0-9]{40}$/u;
const BRANCH =
  /^chore\/next-development\/(4\.\d+\.\d+-alpha\.\d+)-[a-f0-9]{16}$/u;

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
    !BRANCH.test(run.head_branch || "") ||
    (headSha && run.head_sha !== headSha)
  )
    throw new Error("unqualified next-development verification run");
}

export function assertReviewPull(
  pull,
  { repository, headSha, baseSha, branch },
) {
  if (
    repository !== REPOSITORY ||
    pull.head?.repo?.full_name !== repository ||
    pull.base?.repo?.full_name !== repository ||
    pull.head?.sha !== headSha ||
    pull.base?.sha !== baseSha ||
    pull.head?.ref !== branch ||
    !BRANCH.test(branch || "") ||
    !/^dev\/v4\/v4\.\d+$/u.test(pull.base?.ref || "") ||
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

function observe(client, repository, runId, expected = {}) {
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

export async function verifyNextDevelopmentReview({
  client,
  repository,
  runId,
  git,
  verifyDelta,
  publication,
}) {
  const { run, pull, baseSha } = observe(client, repository, runId);
  if (git("rev-parse", "HEAD") !== baseSha)
    throw new Error(
      "review runtime is not the exact protected development base",
    );
  git("fetch", "--no-tags", "origin", run.head_sha);
  const parents = git("show", "-s", "--format=%P", run.head_sha).split(" ");
  if (parents.length !== 1 || parents[0] !== baseSha)
    throw new Error("next-development must have one exact protected parent");
  const projection = verifyDelta({ baseSha, headSha: run.head_sha });
  if (BRANCH.exec(run.head_branch)[1] !== projection.version)
    throw new Error(
      "next-development branch version differs from regenerated version",
    );
  const version = JSON.parse(git("show", `${baseSha}:package.json`)).version;
  const tag = `v${version}`;
  const sourceSha = client.json(`repos/${repository}/commits/${tag}`).sha;
  const settlement = await publication({ repository, tag, sourceSha });
  const publishedTree = settlement.documents.passport.source.treeHash;
  if (publishedTree !== git("rev-parse", `${baseSha}^{tree}`))
    throw new Error("development base is not the completed alpha source tree");
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

export async function approveNextDevelopment({ client, reviewer, plan }) {
  if (plan.schema !== "buildchain.next-development-review/v1")
    throw new Error("missing verified next-development plan");
  const { pull } = observe(client, plan.repository, plan.runId, plan);
  const identity = reviewer.json("user");
  if (identity.login !== REVIEWER || identity.login === pull.user?.login)
    throw new Error(
      "next-development requires the independent CODEOWNER identity",
    );
  const endpoint = `repos/${plan.repository}/pulls/${plan.number}/reviews`;
  const approved = (review) =>
    review.user?.login === REVIEWER &&
    review.commit_id === plan.headSha &&
    review.state === "APPROVED";
  const reviews = client.pages(endpoint);
  const latest = reviews
    .filter(
      (review) =>
        review.user?.login === REVIEWER &&
        ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state),
    )
    .at(-1);
  if (latest?.state === "CHANGES_REQUESTED")
    throw new Error(
      "independent reviewer requested changes; automation cannot override it",
    );
  if (!latest || !approved(latest)) {
    observe(client, plan.repository, plan.runId, plan);
    await reviewer.post(endpoint, {
      event: "APPROVE",
      commit_id: plan.headSha,
      body: `Verified the exact version-only transition by regenerating all tracked bytes from protected base ${plan.baseSha}. Completed alpha receipt: ${plan.publicationReceiptRoot}. Verification run: https://github.com/${plan.repository}/actions/runs/${plan.runId}.`,
    });
  }
  observe(client, plan.repository, plan.runId, plan);
  const readback = client.pages(endpoint).filter(approved).at(-1);
  if (!readback)
    throw new Error("independent exact-head approval readback failed");
  return { ...plan, reviewId: readback.id, reviewUrl: readback.html_url };
}

function api(token) {
  const call = (endpoint, args = [], input) =>
    JSON.parse(
      execFileSync("gh", ["api", endpoint, ...args], {
        encoding: "utf8",
        input,
        env: { ...process.env, GH_TOKEN: token },
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  return {
    json: (endpoint) => call(endpoint),
    pages: (endpoint, field) =>
      call(endpoint, ["--paginate", "--slurp"]).flatMap((page) =>
        field ? page[field] : page,
      ),
    post: (endpoint, body) =>
      call(
        endpoint,
        ["--method", "POST", "--input", "-"],
        JSON.stringify(body),
      ),
  };
}

async function main(mode) {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.VERIFY_RUN_ID;
  if (!/^\d+$/u.test(runId || "") || repository !== REPOSITORY)
    throw new Error("exact repository and verification run required");
  const client = api(process.env.GH_TOKEN);
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
          client: releaseAssetClient(repository),
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
      reviewer: api(process.env.BUILDCHAIN_APPROVAL_TOKEN),
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
    const { pull } = observe(client, repository, runId, plan);
    const reviews = client.pages(
      `repos/${repository}/pulls/${plan.number}/reviews`,
    );
    if (
      !reviews.some(
        (review) =>
          review.id === plan.reviewId &&
          review.user?.login === REVIEWER &&
          review.commit_id === plan.headSha &&
          review.state === "APPROVED",
      )
    )
      throw new Error("independent approval no longer qualifies enqueue");
    await enqueueNextDevelopmentPullRequest({
      pull,
      headSha: plan.headSha,
      mutationOctokit: {
        graphql: async (query, variables) => {
          const result = client.post("graphql", { query, variables });
          if (result.errors?.length)
            throw new Error(
              result.errors.map((error) => error.message).join("; "),
            );
          return result.data;
        },
      },
      wait: (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
      maxPolls: 20,
    });
  } else throw new Error("expected verify, approve or enqueue");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
