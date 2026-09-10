import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewedCandidateEvidence,
  bootstrapVersionLine,
} from "../packages/core/workflow/admission/review.js";
import {
  recoveryCoordinates,
  recoveryTerminalReceipt,
} from "../packages/core/workflow/admission/recovery.js";

const sha = (x) => x.repeat(40);
const root = (x) => `sha256:${x.repeat(64)}`;
function facts() {
  return {
    request: {
      mode: "train",
      candidate: {
        repository: "kungfu-systems/buildchain",
        expectedSha: sha("a"),
        reviewPullRequest: 123,
      },
    },
    pr: {
      number: 123,
      head: { repo: { full_name: "kungfu-systems/buildchain" }, sha: sha("a") },
      base: { ref: "dev/v4/v4.1" },
    },
    reviews: [
      {
        state: "APPROVED",
        commit_id: sha("a"),
        user: { login: "kungfu-origin" },
        submitted_at: "2026-09-09T00:00:00Z",
      },
    ],
    checks: [{ name: "check", status: "completed", conclusion: "success" }],
    commit: { parents: [{ sha: sha("b") }] },
    line: { development: "dev/v4/v4.1", alpha: "alpha/v4/v4.1" },
    observedAt: "2026-09-09T01:00:00Z",
  };
}
test("Bootstrap requires independently reviewed exact runtime on its own development line", () => {
  const value = facts();
  assert.equal(
    reviewedCandidateEvidence(value).runtimeBinding.kind,
    "reviewed-head",
  );
  assert.deepEqual(bootstrapVersionLine(), {
    development: "dev/v4/v4.1",
    alpha: "alpha/v4/v4.1",
  });
  for (const mutate of [
    (x) => {
      x.pr.head.sha = sha("c");
    },
    (x) => {
      x.pr.base.ref = "dev/v4/v4.0";
    },
    (x) => {
      x.reviews[0].commit_id = sha("c");
    },
    (x) => {
      x.reviews[0].user.login = "caller";
    },
    (x) => {
      x.checks[0].conclusion = "failure";
    },
    (x) => {
      x.pr.head.repo.full_name = "fork/buildchain";
    },
  ]) {
    const changed = structuredClone(value);
    mutate(changed);
    assert.throws(() => reviewedCandidateEvidence(changed));
  }
});
test("Alpha merge review is bound to the exact protected merge and reviewed source", () => {
  const value = facts();
  value.request.mode = "alpha";
  value.request.candidate.expectedSha = sha("c");
  Object.assign(value.pr, {
    merged: true,
    merge_commit_sha: sha("c"),
    merged_at: "2026-09-09T00:30:00Z",
    base: { ref: "alpha/v4/v4.1" },
  });
  value.commit.parents.push({ sha: sha("a") });
  const evidence = reviewedCandidateEvidence(value);
  assert.equal(evidence.runtimeBinding.kind, "protected-alpha-merge");
  assert.equal(evidence.headSha, sha("a"));
  assert.equal(evidence.runtimeBinding.runtimeSha, sha("c"));
  value.pr.merge_commit_sha = sha("d");
  assert.throws(() => reviewedCandidateEvidence(value));
});
test("Recovery parses coordinates before candidate execution and rejects movable or cross-repository requests", () => {
  const request = {
    schema: "kungfu-buildchain-v4-universal-workflow-request/v1",
    ...facts().request,
  };
  request.candidate.discoveryRef = "train/v4/v4.1/bootstrap";
  assert.equal(recoveryCoordinates(request).sha, sha("a"));
  for (const change of [
    { expectedSha: "v4-alpha" },
    { discoveryRef: "dev/v4/v4.1" },
    { discoveryRef: "train/v4/v4.1/../../x" },
    { repository: "fork/buildchain" },
    { reviewPullRequest: 1.5 },
  ])
    assert.throws(() =>
      recoveryCoordinates({
        ...request,
        candidate: { ...request.candidate, ...change },
      }),
    );
});
test("Recovery terminal receipt remains outside candidate authority and rejects lineage substitutions", () => {
  const admission = {
    schema: "kungfu-buildchain-v4-universal-workflow-admission/v1",
    status: "admitted",
    requestRoot: root("a"),
    admissionRoot: root("b"),
    discoveryRoot: root("c"),
    reviewRoot: root("d"),
    consumerRoot: root("e"),
    capabilityRoot: root("f"),
    runtime: { repository: "kungfu-systems/buildchain", sha: sha("a") },
    permissions: {},
    contractRoots: [],
  };
  const result = {
    schema: "kungfu-buildchain-v4-universal-workflow-result/v1",
    status: "succeeded",
    requestRoot: admission.requestRoot,
    capabilityRoot: admission.capabilityRoot,
    runtime: admission.runtime,
    resultRoot: root("1"),
  };
  const receipt = recoveryTerminalReceipt(admission, result);
  assert.match(receipt.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    recoveryTerminalReceipt(admission, { ...result, status: "failed" }).status,
    "failed",
  );
  for (const change of [
    { requestRoot: root("2") },
    { capabilityRoot: root("2") },
    { runtime: { ...admission.runtime, sha: sha("b") } },
    { resultRoot: "unrooted" },
  ])
    assert.throws(() =>
      recoveryTerminalReceipt(admission, { ...result, ...change }),
    );
});

test("Bootstrap rejects superseded approvals and stale successful checks", () => {
  const changedReview = facts();
  changedReview.reviews.push({ ...changedReview.reviews[0], state: "CHANGES_REQUESTED", submitted_at: "2026-09-09T00:30:00Z" });
  assert.throws(() => reviewedCandidateEvidence(changedReview), /independent kungfu-origin approval/);
  const pending = facts();
  pending.checks = [{ name: "check", id: 10, status: "in_progress", head_sha: sha("a") }, { name: "check", id: 9, status: "completed", conclusion: "success", head_sha: sha("a") }];
  assert.throws(() => reviewedCandidateEvidence(pending), /successful check/);
  pending.checks[0].status = "completed";
  pending.checks[0].conclusion = "success";
  assert.equal(reviewedCandidateEvidence(pending).checks.length, 1);
  pending.checks[0].head_sha = sha("c");
  assert.throws(() => reviewedCandidateEvidence(pending), /different candidate/);
});
