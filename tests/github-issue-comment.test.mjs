import test from "node:test";
import assert from "node:assert/strict";
import { upsertIssueComment } from "../packages/core/providers/github-issue-comment.js";
const request = {
  token: "fixture",
  repository: "test/site",
  issueNumber: 7,
  marker: "<!-- result -->",
  body: "<!-- result -->\nnew",
};
test("comment capability searches later pages before creating a duplicate", async () => {
  const calls = [];
  const result = await upsertIssueComment({
    ...request,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method) {
        assert.equal(options.method, "PATCH");
        return { ok: true };
      }
      return {
        ok: true,
        json: async () =>
          url.includes("page=2")
            ? [{ id: 88, body: request.marker }]
            : Array.from({ length: 100 }, (_, id) => ({
                id,
                body: "ordinary",
              })),
      };
    },
  });
  assert.deepEqual(result, { action: "updated", commentId: 88 });
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /comments\/88$/);
});
test("listing failure cannot fall through to comment creation", async () => {
  const calls = [];
  await assert.rejects(
    upsertIssueComment({
      ...request,
      fetchImpl: async (_, options) => {
        calls.push(options.method);
        return { ok: false, status: 403 };
      },
    }),
    /HTTP 403/,
  );
  assert.deepEqual(calls, [undefined]);
});
