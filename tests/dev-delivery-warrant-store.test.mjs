import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubDevDeliveryStore,
  defaultDevDeliveryStateRef,
} from "../scripts/dev-delivery-warrant.mjs";
import { createDevDeliveryQueue } from "../packages/core/dev-delivery-warrant.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rawResponse(data, status = 200) {
  return new Response(data, {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("GitHub state store retries a truncated immutable queue read", async () => {
  const commitSha = "a".repeat(40);
  const state = createDevDeliveryQueue({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    now: "2026-08-04T00:00:00Z",
  });
  let blobReads = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === "GET" && url.includes("/git/ref/heads/")) {
      return jsonResponse({ object: { sha: commitSha } });
    }
    if (options.method === "GET" && url.endsWith(`/git/commits/${commitSha}`)) {
      return jsonResponse({ tree: { sha: "tree-sha" } });
    }
    if (options.method === "GET" && url.endsWith("/git/trees/tree-sha")) {
      return jsonResponse({
        tree: [{ path: "queue.json", type: "blob", sha: "blob-sha" }],
      });
    }
    if (options.method === "GET" && url.endsWith("/git/blobs/blob-sha")) {
      blobReads += 1;
      const bytes = `${JSON.stringify(state, null, 2)}\n`;
      return rawResponse(blobReads === 1 ? bytes.slice(0, -2) : bytes);
    }
    throw new Error(`unexpected request: ${options.method} ${url}`);
  };
  const store = new GitHubDevDeliveryStore({
    repository: "kungfu-systems/kungfu",
    token: "test-token",
    fetchImpl,
  });

  const read = await store.read({
    stateRef: defaultDevDeliveryStateRef("dev/v4/v4.0"),
    protectedBase: "dev/v4/v4.0",
    now: "2026-08-04T00:00:00Z",
  });
  assert.equal(read.commitSha, commitSha);
  assert.equal(read.queue.stateRoot, state.stateRoot);
  assert.equal(blobReads, 2);
});
