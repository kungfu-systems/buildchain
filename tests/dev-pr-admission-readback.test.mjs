import assert from "node:assert/strict";
import test from "node:test";
import { runDevPrAdmission } from "../scripts/dev-pr-auto-merge.mjs";

const exactHead = "a".repeat(40);
const options = {
  repository: "kungfu-systems/buildchain",
  targetBranch: "dev/v2/v2.6",
  targetPullRequestNumber: 21,
  expectedHeadSha: exactHead,
  landingMode: "direct",
  requiredChecks: "check",
  dryRun: true,
  qualificationOnly: true,
  pollMergeableDelayMs: 0,
};

function pullRequest() {
  return {
    number: 21,
    state: "open",
    draft: false,
    mergeable: true,
    mergeable_state: "clean",
    labels: [{ name: "ready" }],
    head: { ref: "fix/readback", sha: exactHead, repo: { full_name: "kungfu-systems/buildchain" } },
    base: { ref: "dev/v2/v2.6" },
  };
}

function client(read) {
  return {
    getPullRequest: read,
    listReviews: async () => [{ user: { login: "reviewer" }, state: "APPROVED" }],
    listCommitChecks: async () => ({ statuses: [{ context: "check", state: "success" }], checkRuns: [] }),
  };
}

test("targeted source qualification retries a transient exact PR read", async () => {
  const target = pullRequest();
  let reads = 0;
  const result = await runDevPrAdmission({ ...options, pollMergeableAttempts: 2 }, client(async () => {
    reads += 1;
    if (reads === 1) throw new Error("temporary GitHub read failure");
    return target;
  }));
  assert.equal(result.ok, true);
  assert.ok(reads >= 2);
});

test("targeted source qualification reports an unavailable exact PR read without claiming it is closed", async () => {
  const result = await runDevPrAdmission(
    { ...options, pollMergeableAttempts: 1 },
    client(async () => { throw new Error("temporary GitHub read failure"); }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.receipt.state, "blocked");
  assert.equal(result.receipt.reason, "pull-request-read-failed");
});
