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
import { qualifyRecoveryIntegration } from "../packages/core/workflow/pipeline/recovery-integration.js";

function fixture({ mutateReadback, moveProtectedBase = false } = {}) {
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
    baseReads = 0,
    drift = false,
    corrupt = false;
  const urls = [];
  const request = async (url) => {
    urls.push(url);
    if (url.endsWith("/pulls/23")) {
      prReads++;
      const value = structuredClone(pr);
      if (drift && prReads > 1) value.head.sha = "f".repeat(40);
      if (prReads % 2 === 0) mutateReadback?.(value);
      return value;
    }
    if (url === `/repos/${repository}`) return { node_id: "R1" };
    if (url.includes("/git/ref/"))
      return {
        object: {
          type: "commit",
          sha: moveProtectedBase && ++baseReads > 1 ? "e".repeat(40) : base,
        },
      };
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

test("source observation ignores metadata and speculative merge updates", async () => {
  const f = fixture({
    mutateReadback(pr) {
      pr.updated_at = "2026-09-13T19:14:23Z";
      pr.head.repo.updated_at = "2026-09-13T19:14:23Z";
      pr.base.repo.pushed_at = "2026-09-13T19:14:23Z";
      pr.merge_commit_sha = "d".repeat(40);
      pr.labels = [
        { name: "documentation" },
        { name: "ready", color: "ffffff" },
      ];
    },
  });
  const observed = await f.provider.observe(23);
  assert.equal(observed.live.source.commit, "a".repeat(40));
  assert.equal(observed.live.baseCommit, "b".repeat(40));
  assert.equal(observed.live.ready, true);
  assert.equal(observed.live.mergeCommit, null);
});

test("source observation still rejects identity, route and readiness drift", async () => {
  const mutations = [
    (pr) => {
      pr.head.repo.full_name = "attacker/fork";
    },
    (pr) => {
      pr.head.repo.id = 24;
    },
    (pr) => {
      pr.base.repo.node_id = "replacement";
    },
    (pr) => {
      pr.head.ref = "fix/other";
    },
    (pr) => {
      pr.base.ref = "dev/v1/v1.1";
    },
    (pr) => {
      pr.base.sha = "e".repeat(40);
    },
    (pr) => {
      pr.draft = true;
    },
    (pr) => {
      pr.labels = [];
    },
    (pr) => {
      pr.state = "closed";
    },
    (pr) => {
      pr.merged = true;
      pr.merge_commit_sha = "d".repeat(40);
    },
  ];
  for (const mutateReadback of mutations) {
    const f = fixture({ mutateReadback });
    await assert.rejects(f.provider.observe(23), /changed during observation/);
  }
  const movedBase = fixture({ moveProtectedBase: true });
  await assert.rejects(
    movedBase.provider.observe(23),
    /changed during observation/,
  );
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

test("terminal observation ignores metadata but binds the actual merge commit", async () => {
  let replaceMerged = false;
  const f = fixture({
    mutateReadback(pr) {
      pr.updated_at = "2026-09-13T19:14:23Z";
      pr.base.repo.updated_at = "2026-09-13T19:14:23Z";
      if (replaceMerged && pr.merged) pr.merge_commit_sha = "e".repeat(40);
    },
  });
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
  f.pr.state = "closed";
  f.pr.merged = true;
  f.pr.merge_commit_sha = "d".repeat(40);
  const observed = await f.provider.observeIntent(intent, generation);
  assert.equal(observed.cleanupOnly, true);
  assert.equal(observed.live.mergeCommit, "d".repeat(40));
  replaceMerged = true;
  await assert.rejects(
    f.provider.observeIntent(intent, generation),
    /changed during terminal observation/,
  );
});

test("merged recovery reobserves protected review policy through the real source adapter", async () => {
  const f = fixture();
  const initial = await f.provider.observe(23);
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
    initial.live.source,
    initial.live.baseCommit,
  );
  f.pr.state = "closed";
  f.pr.merged = true;
  f.pr.merge_commit_sha = "d".repeat(40);
  const admission = await f.provider.observeIntent(intent, generation);
  assert.equal(admission.protectedPlan, undefined);
  const session = { intent, observed: { history: [{ generation }] } };
  let policyReads = 0;
  const host = {
    source: f.provider,
    integration: {
      observe: async () => ({ mergeCommit: f.pr.merge_commit_sha }),
    },
    policy: {
      observeMerged: async (_current, policy) => {
        assert.deepEqual(policy, initial.protectedPlan.review);
        policyReads++;
        return { review: true, checksPassing: true };
      },
    },
  };
  await qualifyRecoveryIntegration(session, admission, host);
  assert.equal(policyReads, 1);
  f.pr.merge_commit_sha = "e".repeat(40);
  await assert.rejects(
    qualifyRecoveryIntegration(session, admission, host),
    /changed protected integration/,
  );
  assert.equal(policyReads, 1);
  f.pr.merge_commit_sha = admission.live.mergeCommit;
  host.policy.observeMerged = async () => ({
    review: false,
    checksPassing: true,
  });
  await assert.rejects(
    qualifyRecoveryIntegration(session, admission, host),
    /current exact review and required checks/,
  );
});
