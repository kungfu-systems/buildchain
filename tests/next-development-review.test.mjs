import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReviewRun,
  assertReviewPull,
  verifyNextDevelopmentReview,
  approveNextDevelopment,
} from "../scripts/next-development-review.mjs";

const repository = "kungfu-systems/buildchain";
const headSha = "a".repeat(40),
  baseSha = "b".repeat(40),
  sourceSha = "c".repeat(40);
const branch = "chore/next-development/4.0.2-alpha.37-1234567890abcdef";
const runId = 123;
function fixture() {
  const run = {
    id: runId,
    repository: { full_name: repository },
    head_sha: headSha,
    head_branch: branch,
    path: ".github/workflows/self-build-verify.yml",
    name: "Verify",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
  };
  const pull = {
    number: 42,
    node_id: "PR_exact",
    state: "open",
    draft: false,
    user: { login: "dongkeren" },
    head: { sha: headSha, ref: branch, repo: { full_name: repository } },
    base: { sha: baseSha, ref: "dev/v4/v4.0", repo: { full_name: repository } },
  };
  const reviews = [];
  const jobs = [{ name: "check", status: "completed", conclusion: "success" }];
  let reviewerName = "kungfu-origin";
  const writes = [];
  const client = {
    json(endpoint) {
      if (endpoint.includes("actions/runs")) return structuredClone(run);
      if (endpoint.endsWith("pulls/42")) return structuredClone(pull);
      if (endpoint.includes("git/ref/heads"))
        return { object: { sha: baseSha } };
      if (endpoint.includes("commits/v")) return { sha: sourceSha };
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
    pages(endpoint) {
      if (endpoint.endsWith("/pulls")) return [structuredClone(pull)];
      if (endpoint.includes("/jobs")) return structuredClone(jobs);
      if (endpoint.endsWith("/reviews")) return structuredClone(reviews);
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };
  const reviewer = {
    json: () => ({ login: reviewerName }),
    post(_endpoint, body) {
      writes.push(body);
      reviews.push({
        id: 91,
        user: { login: reviewerName },
        commit_id: body.commit_id,
        state: "APPROVED",
        html_url: "https://github.com/review/91",
      });
    },
  };
  const gitCalls = [];
  const git = (...args) => {
    gitCalls.push(args);
    if (args[0] === "fetch") return "";
    if (args[0] === "rev-parse") return args[1] === "HEAD" ? baseSha : "tree";
    if (args.includes("--format=%P")) return baseSha;
    return JSON.stringify({ version: "4.0.2-alpha.36" });
  };
  const options = {
    client,
    repository,
    runId,
    git,
    verifyDelta: (coordinates) => ({
      ...coordinates,
      version: "4.0.2-alpha.37",
    }),
    publication: async () => ({
      documents: {
        passport: { source: { treeHash: "tree" } },
        receipt: { receiptRoot: "sha256:" + "d".repeat(64) },
      },
    }),
  };
  return {
    run,
    pull,
    reviews,
    jobs,
    writes,
    gitCalls,
    options,
    client,
    reviewer,
    setReviewer: (name) => {
      reviewerName = name;
    },
  };
}

test("completed publication plus protected regeneration permits one independent exact-head review", async () => {
  const f = fixture();
  const plan = await verifyNextDevelopmentReview(f.options);
  const result = await approveNextDevelopment({
    client: f.client,
    reviewer: f.reviewer,
    plan,
  });
  assert.equal(result.reviewId, 91);
  assert.equal(f.writes[0].commit_id, headSha);
  assert.ok(
    f.gitCalls.some(
      (args) => args.join(" ") === `fetch --no-tags origin ${headSha}`,
    ),
  );
  await approveNextDevelopment({
    client: f.client,
    reviewer: f.reviewer,
    plan,
  });
  assert.equal(f.writes.length, 1);
});

test("verification run cannot be forged with another workflow, source, event or result", () => {
  const { run } = fixture();
  for (const delta of [
    { path: "evil.yml" },
    { head_sha: baseSha },
    { event: "workflow_dispatch" },
    { conclusion: "failure" },
    { status: "in_progress" },
    { head_branch: "feature/ordinary" },
    { repository: { full_name: "fork/buildchain" } },
    { id: 124 },
  ])
    assert.throws(() =>
      assertReviewRun({ ...run, ...delta }, { repository, runId, headSha }),
    );
});

test("forks, source edits, stale bases and incomplete publication never receive approval", async () => {
  for (const change of [
    (f) => {
      f.pull.head.repo.full_name = "fork/buildchain";
    },
    (f) => {
      f.pull.base.sha = sourceSha;
    },
    (f) => {
      f.pull.draft = true;
    },
    (f) => {
      f.jobs[0].conclusion = "skipped";
    },
    (f) => {
      f.options.verifyDelta = () => {
        throw new Error("source changed");
      };
    },
    (f) => {
      f.options.publication = async () => {
        throw new Error("missing receipt");
      };
    },
    (f) => {
      f.options.git = () => sourceSha;
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(verifyNextDevelopmentReview(f.options));
    assert.equal(f.writes.length, 0);
  }
});

test("fresh provider observations fence review authority and stale plans", async () => {
  for (const change of [
    (f) => {
      f.pull.head.sha = sourceSha;
    },
    (f) => {
      f.pull.base.ref = "release/v4/v4.0";
    },
    (f) => {
      f.setReviewer("dongkeren");
    },
    (f) => {
      f.reviews.push({
        user: { login: "kungfu-origin" },
        state: "CHANGES_REQUESTED",
        commit_id: headSha,
      });
    },
    (f) => {
      f.reviewer.post = () => {};
    },
  ]) {
    const f = fixture();
    const plan = await verifyNextDevelopmentReview(f.options);
    change(f);
    await assert.rejects(
      approveNextDevelopment({ client: f.client, reviewer: f.reviewer, plan }),
    );
  }
  const f = fixture();
  assert.throws(() =>
    assertReviewPull(
      { ...f.pull, user: { login: "kungfu-origin" } },
      { repository, headSha, baseSha, branch },
    ),
  );
});

test("authority closure follows module imports without treating generated program text as executable imports", async () => {
  const { localModuleSpecifiers } =
    await import("../scripts/check-v4-release-topology.mjs");
  assert.deepEqual(
    localModuleSpecifiers(
      "import x from './actual.js'; export { y } from './export.js'; const program = `import z from './generated.js'`; await import('./dynamic.js'); // import './comment.js'\n",
    ),
    ["./actual.js", "./dynamic.js", "./export.js"],
  );
});
