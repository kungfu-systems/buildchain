import test from "node:test";
import assert from "node:assert/strict";
import { pipelineVersionFixture } from "./helpers/pipeline-version.mjs";
import { planPipelinePublication } from "../packages/core/publication/pipeline/plan.js";
import { nextPipelineDevelopment } from "../packages/core/publication/pipeline/next-development.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

function fixture({ channel = "alpha" } = {}) {
  const f = pipelineVersionFixture();
  const source = {
    ...f.plan.source,
    configPath: ".buildchain/buildchain.toml",
  };
  const plan = planPipelinePublication({
    ...f.plan,
    source,
    contract: f.contract,
    route: f.contract.channels[channel === "alpha" ? 1 : 2],
    version: "1.0.0-alpha.1",
  });
  const context = {
    attempt: `attempt-${"a".repeat(64)}`,
    plan,
    materialization: { source },
  };
  const publication = {
    release: { receiptRoot: recordDigest("real publication fixture") },
    completedAt: "2026-09-13T01:00:00.000Z",
  };
  const records = [
    { id: "publication/complete/fixture", value: structuredClone(publication) },
  ];
  const journal = {
    materials: async (prefix) =>
      records
        .filter(({ id }) => id.startsWith(prefix))
        .map(({ value }) => structuredClone(value)),
    record: async (id, value) =>
      records.push({
        id: `${id}/${recordDigest(value)}`,
        value: structuredClone(value),
      }),
    fence: async () => {},
  };
  let pr,
    requests = 0,
    integrations = 0;
  const host = {
    repository: source.repository,
    source: {
      branchHead: async () => source.commit,
      source: async (commit) => ({
        identity: { ...source, commit, tree: f.commits.get(commit).tree.sha },
        plan: f.contract,
      }),
    },
    request: async (url, options = {}) => {
      if (url.includes("/pulls?")) return pr ? [pr] : [];
      if (url.endsWith("/pulls/7")) return structuredClone(pr);
      return f.request(url, options);
    },
    pullRequests: async (url, options) => {
      requests++;
      const body = options.body;
      pr = {
        number: 7,
        head: {
          ref: body.head,
          sha: f.refs.get(`heads/${body.head}`),
          repo: { full_name: source.repository },
        },
        base: { ref: body.base },
        body: body.body,
        state: "open",
        merged: false,
        created_at: "2026-09-13T01:01:00Z",
      };
      return structuredClone(pr);
    },
    integration: {
      observe: async (current) => {
        integrations++;
        assert.equal(current.generation.source.commit, pr.head.sha);
        assert.equal(pr.merged, true);
        return { mergeCommit: pr.head.sha, root: recordDigest(pr) };
      },
    },
  };
  return {
    f,
    context,
    host,
    journal,
    records,
    publication,
    requests: () => requests,
    integrations: () => integrations,
    merge: () => {
      pr.merged = true;
      pr.state = "closed";
      pr.merged_at = "2026-09-13T01:02:00Z";
    },
  };
}

test("next-development keeps published Alpha success while an ordinary exact-source PR awaits protected integration", async () => {
  const f = fixture();
  const pending = await nextPipelineDevelopment(f.context, f.host, f.journal);
  assert.equal(pending.state, "waiting");
  assert.equal(pending.transition.state.status, "pr-pending");
  assert.equal(pending.transition.target.version, "1.0.0-alpha.2");
  assert.equal(f.requests(), 1);
  const writes = f.f.writes.length;
  const repeated = await nextPipelineDevelopment(f.context, f.host, f.journal);
  assert.deepEqual(repeated, pending);
  assert.equal(f.requests(), 1);
  assert.equal(f.f.writes.length, writes);
  assert.equal(f.integrations(), 0);
  f.merge();
  const complete = await nextPipelineDevelopment(f.context, f.host, f.journal);
  assert.equal(complete.state, "success");
  assert.equal(complete.transition.state.status, "verified");
  assert.equal(complete.publicationRoot, f.publication.release.receiptRoot);
  assert.deepEqual(f.records[0].value, f.publication);
  assert.equal(f.integrations(), 1);
  assert.ok(
    [...f.f.refs.keys()].every((ref) =>
      ref.startsWith("heads/feature/buildchain-next/"),
    ),
  );
});

test("anchored next-development waits for a real protected version change and never infers or writes its authority", async () => {
  const f = fixture();
  f.f.contract.version.strategy = "anchored";
  const old = f.context.plan;
  f.context.plan = planPipelinePublication({
    ...old,
    source: old.source,
    contract: f.f.contract,
    route: f.f.contract.channels[1],
    version: old.version,
  });
  const request = f.host.request;
  f.host.request = async (url, options) =>
    url.includes("/compare/")
      ? { status: "ahead", merge_base_commit: { sha: old.source.commit } }
      : request(url, options);
  const pending = await nextPipelineDevelopment(f.context, f.host, f.journal);
  assert.equal(pending.reason, "waiting-for-protected-version-anchor");
  assert.equal(f.f.writes.length, 0);
  assert.equal(f.requests(), 0);
  // Fixture provider models a separately reviewed human version change.
  const human = await f.f.provider.materializeDevelopment({
    source: old.source,
    versionPolicy: { ...old.versionPolicy, strategy: "semver" },
    version: "2.0.0-alpha.1",
    sourceTimestamp: old.sourceTimestamp,
    root: recordDigest("human anchor fixture"),
  });
  const writes = f.f.writes.length;
  f.host.source.branchHead = async () => human.source.commit;
  const pr = {
    number: 9,
    head: { sha: human.source.commit },
    base: { ref: old.route.from },
    merge_commit_sha: human.source.commit,
    created_at: "2026-09-13T01:04:00Z",
    merged_at: "2026-09-13T01:05:00Z",
  };
  const wrapped = f.host.request;
  f.host.request = async (url, options) =>
    url.endsWith(`/commits/${human.source.commit}/pulls?per_page=100`)
      ? [pr]
      : url.endsWith("/pulls/9")
        ? pr
        : wrapped(url, options);
  f.host.integration.observe = async () => ({
    mergeCommit: human.source.commit,
    root: recordDigest(pr),
  });
  const complete = await nextPipelineDevelopment(f.context, f.host, f.journal);
  assert.equal(complete.state, "success");
  assert.equal(complete.transition.target.version, "2.0.0-alpha.1");
  assert.equal(complete.transition.state.status, "verified");
  assert.equal(complete.anchor.manifestPath, "package.json");
  assert.equal(f.f.writes.length, writes);
  assert.equal(f.requests(), 0);
});

test("stable publication opens a normal protected Dev PR for the next patch alpha zero and preserves successful publication while pending", async () => {
  const f = fixture({ channel: "stable" });
  f.context.materialization = await f.f.provider.materialize(f.context.plan);
  const pending = await nextPipelineDevelopment(f.context, f.host, f.journal);
  assert.equal(pending.state, "waiting");
  assert.equal(pending.transition.target.version, "1.0.1-alpha.0");
  assert.equal(
    pending.transition.contract,
    "buildchain.stable-development-transition/v1",
  );
  const selected = f.records.find(({ id }) =>
    id.startsWith("publication/next-development-pr/"),
  ).value;
  assert.equal(selected.base, "dev/v1/v1.0");
  assert.deepEqual(f.records[0].value, f.publication);
  f.merge();
  const completed = await nextPipelineDevelopment(f.context, f.host, f.journal);
  assert.equal(completed.state, "success");
  assert.equal(completed.version, "1.0.1-alpha.0");
  assert.equal(completed.transition.state.status, "verified");
  assert.equal(f.requests(), 1);
  assert.deepEqual(f.records[0].value, f.publication);
});

test("a late publication cannot regress already advanced protected development or accept an unproved version", async () => {
  const f = fixture();
  const newer = await f.f.provider.materializeDevelopment({
    source: f.context.plan.source,
    versionPolicy: f.context.plan.versionPolicy,
    version: "1.0.1-alpha.0",
    sourceTimestamp: f.context.plan.sourceTimestamp,
    root: recordDigest("newer protected version"),
  });
  const writes = f.f.writes.length;
  f.host.source.branchHead = async () => newer.source.commit;
  const pr = {
    number: 8,
    head: { sha: newer.source.commit },
    base: { ref: f.context.plan.developmentBranch },
    merge_commit_sha: newer.source.commit,
  };
  const request = f.host.request;
  f.host.request = async (url, options) =>
    url.includes(`/commits/${newer.source.commit}/pulls?`)
      ? [pr]
      : url.endsWith("/pulls/8")
        ? pr
        : request(url, options);
  f.host.integration.observe = async () => {
    throw new Error("missing protected checks");
  };
  await assert.rejects(
    nextPipelineDevelopment(f.context, f.host, f.journal),
    /missing protected checks/,
  );
  f.host.integration.observe = async () => ({
    mergeCommit: newer.source.commit,
    root: recordDigest(pr),
  });
  const result = await nextPipelineDevelopment(f.context, f.host, f.journal);
  assert.equal(result.reason, "protected-development-already-advanced");
  assert.equal(result.observedVersion, "1.0.1-alpha.0");
  assert.equal(f.f.writes.length, writes);
  assert.equal(f.requests(), 0);
  assert.deepEqual(f.records[0].value, f.publication);
});

test("anchored stable follow-up requires a new reviewed manual anchor after publication", async () => {
  const f = fixture({ channel: "stable" });
  f.context.materialization = await f.f.provider.materialize(f.context.plan);
  f.f.contract.version.strategy = "anchored";
  f.context.plan = planPipelinePublication({
    ...f.context.plan,
    contract: f.f.contract,
    route: f.f.contract.channels[2],
    version: "1.0.0",
  });
  let source = f.context.plan.source;
  let mergedAt = "2026-09-13T00:50:00Z";
  f.host.source.branchHead = async () => source.commit;
  const pr = () => ({
    number: 9,
    head: { sha: source.commit },
    base: { ref: f.context.plan.developmentBranch },
    merge_commit_sha: source.commit,
    created_at: mergedAt,
    merged_at: mergedAt,
  });
  const request = f.host.request;
  f.host.request = async (url, options) =>
    url.includes(`/commits/${source.commit}/pulls?`)
      ? [pr()]
      : url.endsWith("/pulls/9")
        ? pr()
        : request(url, options);
  f.host.integration.observe = async () => ({
    mergeCommit: source.commit,
    root: recordDigest(pr()),
  });
  const writesBefore = f.f.writes.length;
  const waiting = await nextPipelineDevelopment(f.context, f.host, f.journal);
  assert.equal(waiting.state, "waiting");
  assert.equal(f.f.writes.length, writesBefore);
  const human = await f.f.provider.materializeDevelopment({
    source,
    versionPolicy: { ...f.context.plan.versionPolicy, strategy: "semver" },
    version: "2.0.0-alpha.1",
    sourceTimestamp: f.context.plan.sourceTimestamp,
    root: recordDigest("reviewed stable anchor"),
  });
  source = human.source;
  mergedAt = "2026-09-13T01:05:00Z";
  const writesAfterHuman = f.f.writes.length;
  const completed = await nextPipelineDevelopment(f.context, f.host, f.journal);
  assert.equal(completed.state, "success");
  assert.equal(completed.transition.target.version, "2.0.0-alpha.1");
  assert.equal(completed.transition.state.status, "verified");
  assert.equal(f.f.writes.length, writesAfterHuman);
  assert.equal(f.requests(), 0);
  assert.deepEqual(f.records[0].value, f.publication);
});
