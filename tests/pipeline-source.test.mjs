import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { githubPipelineSource } from "../packages/core/providers/github/pipeline-source.js";
import {
  pipelineIntent,
  sourceGeneration,
} from "../packages/core/workflow/attempt/identity.js";
import { runtime } from "./helpers/business-attempt.mjs";

function fixture() {
  const repository = "example/consumer",
    head = "a".repeat(40),
    base = "b".repeat(40);
  const config = readFileSync(
    new URL(
      "../templates/minimal-consumer/npm/.buildchain/buildchain.toml",
      import.meta.url,
    ),
  );
  const blob = createHash("sha1")
    .update(`blob ${config.length}\0`)
    .update(config)
    .digest("hex");
  const pr = {
    number: 23,
    state: "open",
    merged: false,
    merge_commit_sha: null,
    head: { sha: head, ref: "feature/topic", repo: { full_name: repository } },
    base: { sha: base, ref: "dev/v1/v1.0", repo: { full_name: repository } },
    draft: false,
    labels: [{ name: "ready" }],
    updated_at: "2026-09-12T00:00:00Z",
  };
  let prReads = 0,
    drift = false,
    corrupt = false;
  const urls = [];
  const request = async (url) => {
    urls.push(url);
    if (url.endsWith("/pulls/23")) {
      prReads++;
      const value = structuredClone(pr);
      if (drift && prReads > 1) value.head.sha = "f".repeat(40);
      return value;
    }
    if (url === `/repos/${repository}`) return { node_id: "R1" };
    if (url.includes("/git/ref/"))
      return { object: { type: "commit", sha: base } };
    if (url.includes("/git/commits/")) return { tree: { sha: "c".repeat(40) } };
    if (url.includes("/contents/"))
      return {
        type: "file",
        encoding: "base64",
        sha: corrupt ? "d".repeat(40) : blob,
        size: config.length,
        content: config.toString("base64"),
      };
    throw new Error(`Unexpected source read ${url}`);
  };
  return {
    provider: githubPipelineSource(request, repository),
    urls,
    pr,
    drift: () => {
      drift = true;
    },
    corrupt: () => {
      corrupt = true;
    },
  };
}

test("source observation binds TOML bytes and loads policy from protected source", async () => {
  const f = fixture();
  const observed = await f.provider.observe(23);
  assert.equal(observed.eligible, true);
  assert.equal(observed.route.operation, "develop");
  assert.equal(observed.live.source.commit, "a".repeat(40));
  assert.equal(observed.protectedSource.commit, "b".repeat(40));
  assert.equal(observed.protectedPlan.review.minimum_approvals, 1);
  assert.equal(f.urls.filter((url) => url.includes("/contents/")).length, 2);
  assert.ok(
    f.urls
      .filter((url) => url.includes("/contents/"))
      .every((url) => /\?ref=[a-f0-9]{40}$/u.test(url)),
  );
});

test("source updates during readback, forged config blobs and forks fail closed", async () => {
  const moving = fixture();
  moving.drift();
  await assert.rejects(
    moving.provider.observe(23),
    /changed during observation/,
  );
  const corrupt = fixture();
  corrupt.corrupt();
  await assert.rejects(
    corrupt.provider.observe(23),
    /config bytes do not match/,
  );
  const fork = fixture();
  fork.pr.head.repo.full_name = "attacker/fork";
  await assert.rejects(fork.provider.observe(23), /repository-owned/);
  assert.equal(fork.urls.filter((url) => url.includes("/contents/")).length, 1);
});

test("recorded intent cleanup survives changed source and unavailable new TOML", async () => {
  const f = fixture();
  const admitted = await f.provider.observe(23);
  const intent = pipelineIntent({
    repository: "example/consumer",
    repositoryId: "R1",
    pullRequest: 23,
    targetBranch: "dev/v1/v1.0",
    phases: ["admission", "build", "merge"],
    runtime,
  });
  const generation = sourceGeneration(
    intent,
    admitted.live.source,
    admitted.live.baseCommit,
  );
  f.corrupt();
  f.pr.state = "closed";
  const reads = f.urls.filter((url) => url.includes("/contents/")).length;
  assert.equal(
    (await f.provider.observeIntent(intent, generation)).cleanupOnly,
    true,
  );
  assert.equal(
    f.urls.filter((url) => url.includes("/contents/")).length,
    reads,
  );
  f.pr.state = "open";
  f.pr.head.sha = "f".repeat(40);
  const changed = await f.provider.observeIntent(intent, generation);
  assert.equal(changed.cleanupOnly, true);
  assert.equal(changed.live.source, null);
  assert.equal(changed.live.observedHead, "f".repeat(40));
});
