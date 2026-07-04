import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConsumerIssueReport,
  computeConsumerIssueFingerprint,
  createGitHubIssueRequest,
  reportBuildchainIssue,
} from "../packages/core/issue-reporting.js";

function createMockRequest(responses = []) {
  const calls = [];
  const request = async (call) => {
    calls.push(call);
    const response = responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response || {};
  };
  request.calls = calls;
  return request;
}

test("consumer issue report redacts secrets and carries a stable fingerprint marker", () => {
  const first = buildConsumerIssueReport({
    env: {},
    targetRepository: "kungfu-systems/buildchain",
    consumerRepository: "kungfu-systems/libnode",
    workflow: "alpha",
    job: "macos",
    failureCode: "native-build-slow",
    buildchainRef: "v2",
    summary: "authorization: Bearer ghp_123456789012345678901234567890123456",
    body: "token=github_pat_123456789012345678901234567890123456",
  });
  const second = buildConsumerIssueReport({
    env: {},
    targetRepository: "kungfu-systems/buildchain",
    consumerRepository: "kungfu-systems/libnode",
    workflow: "alpha",
    job: "macos",
    failureCode: "native-build-slow",
    buildchainRef: "v2",
  });

  assert.equal(first.fingerprint, second.fingerprint);
  assert.match(first.body, /buildchain-consumer-issue:fingerprint=/);
  assert.doesNotMatch(first.body, /ghp_/);
  assert.doesNotMatch(first.body, /github_pat_/);
  assert.match(first.body, /\[REDACTED\]/);
});

test("computeConsumerIssueFingerprint ignores empty fields and is order independent", () => {
  assert.equal(
    computeConsumerIssueFingerprint({ b: "two", a: "one", c: "" }),
    computeConsumerIssueFingerprint({ a: "one", b: "two" }),
  );
});

test("reportBuildchainIssue creates a new issue when no open matching issue exists", async () => {
  const request = createMockRequest([
    { total_count: 0, items: [] },
    { number: 42, html_url: "https://github.com/kungfu-systems/buildchain/issues/42" },
  ]);

  const result = await reportBuildchainIssue({
    request,
    env: {},
    token: "unused",
    consumerRepository: "kungfu-systems/libnode",
    targetRepository: "kungfu-systems/buildchain",
    failureCode: "release-passport-missing",
  });

  assert.equal(result.action, "created");
  assert.equal(result.created, true);
  assert.equal(result.issueNumber, 42);
  assert.equal(request.calls[0].method, "GET");
  assert.equal(request.calls[1].method, "POST");
  assert.equal(request.calls[1].path, "/repos/kungfu-systems/buildchain/issues");
});

test("reportBuildchainIssue comments on an existing matching issue", async () => {
  const request = createMockRequest([
    {
      total_count: 1,
      items: [{ number: 7, html_url: "https://github.com/kungfu-systems/buildchain/issues/7" }],
    },
    { id: 99 },
  ]);

  const result = await reportBuildchainIssue({
    request,
    env: {},
    consumerRepository: "kungfu-systems/libnode",
    targetRepository: "kungfu-systems/buildchain",
    failureCode: "reusable-build-failed",
  });

  assert.equal(result.action, "commented");
  assert.equal(result.commented, true);
  assert.equal(request.calls[1].path, "/repos/kungfu-systems/buildchain/issues/7/comments");
  assert.match(request.calls[1].body.body, /New matching Buildchain consumer report/);
});

test("reportBuildchainIssue retries issue creation without labels when labels are missing", async () => {
  const missingLabel = new Error("Validation Failed");
  missingLabel.status = 422;
  const request = createMockRequest([
    { total_count: 0, items: [] },
    missingLabel,
    { number: 5, html_url: "https://github.com/kungfu-systems/buildchain/issues/5" },
  ]);

  const result = await reportBuildchainIssue({
    request,
    env: {},
    consumerRepository: "kungfu-systems/libnode",
    targetRepository: "kungfu-systems/buildchain",
    failureCode: "diagnostics-upload-failed",
    labels: "missing-label",
  });

  assert.equal(result.action, "created");
  assert.deepEqual(request.calls[1].body.labels, ["missing-label"]);
  assert.equal(request.calls[2].body.labels, undefined);
});

test("createGitHubIssueRequest retries transient GitHub API failures", async () => {
  const responses = [
    {
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ message: "other side closed" }),
      headers: { get: () => "" },
    },
    {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: [] }),
      headers: { get: () => "" },
    },
  ];
  const seen = [];
  const request = createGitHubIssueRequest({
    token: "token",
    retryDelaysMs: [1],
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return responses.shift();
    },
  });

  const result = await request({ method: "GET", path: "/search/issues?q=x" });

  assert.deepEqual(result, { items: [] });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].options.headers.authorization, "Bearer token");
});
