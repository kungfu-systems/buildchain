import test from "node:test";
import assert from "node:assert/strict";
import { pipelineVersionFixture } from "./helpers/pipeline-version.mjs";
import { qualifyPipelineChannelSource } from "../packages/core/workflow/pipeline/channel-source.js";
import { retainPipelineBuildResult } from "../packages/core/workflow/pipeline/build-result.js";
import { recordPipelineGroup } from "../packages/core/workflow/pipeline/group-control.js";
import { PIPELINE_BUILD_QUALIFICATION } from "../packages/core/workflow/pipeline/build-qualification.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

function fixture(options) {
  const f = pipelineVersionFixture(options);
  const source = {
    ...f.plan.source,
    configPath: ".buildchain/buildchain.toml",
  };
  const host = {
    repository: source.repository,
    request: f.request,
    source: { source: async () => ({ identity: source, plan: f.contract }) },
  };
  host.qualifyChannel = (source, branch) =>
    qualifyPipelineChannelSource(source, branch, host);
  return { ...f, source, host };
}

test("premerge channel qualification reuses exact version blobs and the publication version decision without writes", async () => {
  const f = fixture();
  for (const branch of ["alpha/v1/v1.0", "release/v1/v1.0"]) {
    const { root, ...body } = await f.host.qualifyChannel(f.source, branch);
    assert.equal(root, recordDigest(body));
    assert.equal(body.version, "1.0.0-alpha.1");
    assert.equal(
      body.selection.version,
      branch.startsWith("alpha/") ? "1.0.0-alpha.1" : "1.0.0",
    );
  }
  assert.deepEqual(f.writes, []);
  f.contract.version.strategy = "anchored";
  await assert.rejects(
    f.host.qualifyChannel(f.source, "release/v1/v1.0"),
    /materialized version/,
  );
});

test("channel qualification rejects absent routes, wrong version lanes and source, tree or blob drift", async () => {
  const f = fixture();
  await assert.rejects(
    f.host.qualifyChannel(f.source, "alpha/v2/v2.0"),
    /one publication route/,
  );
  f.contract.channels[1].to = "alpha/v2/v2.0";
  await assert.rejects(
    f.host.qualifyChannel(f.source, "alpha/v2/v2.0"),
    /source and target version lines/,
  );
  f.contract.channels[1].from = "dev/v2/v2.0";
  await assert.rejects(
    f.host.qualifyChannel(f.source, "alpha/v2/v2.0"),
    /publication version line/,
  );
  await assert.rejects(
    f.host.qualifyChannel(
      { ...f.source, tree: "b".repeat(40) },
      "alpha/v1/v1.0",
    ),
    /identity drift/,
  );
  f.contract.channels[1].to = "alpha/v1/v1.0";
  f.contract.channels[1].from = "dev/v1/v1.0";
  const commit = f.commits.get(f.source.commit);
  commit.tree.sha = "b".repeat(40);
  await assert.rejects(
    f.host.qualifyChannel(f.source, "alpha/v1/v1.0"),
    /source tree drift/,
  );
  commit.tree.sha = f.source.tree;
  f.host.request = async (url, options) => {
    const result = await f.request(url, options);
    return url.includes("/git/blobs/")
      ? { ...result, content: "dGFtcGVyZWQ=" }
      : result;
  };
  await assert.rejects(
    f.host.qualifyChannel(f.source, "alpha/v1/v1.0"),
    /blob identity drift/,
  );
  assert.deepEqual(f.writes, []);
});

test("version disagreement cannot become a successful normal or recovery required check", async () => {
  for (const schema of [
    "buildchain.pipeline-build-readback/v1",
    PIPELINE_BUILD_QUALIFICATION,
  ]) {
    const f = fixture({
      derivedFiles: { "other.json": '{"version":"2.0.0-alpha.1"}' },
    });
    f.contract.version.files.push({
      path: "other.json",
      format: "json",
      key: "version",
    });
    let effects = 0;
    const session = {
      intent: {
        expectedNodes: ["publish"],
        source: { targetBranch: "alpha/v1/v1.0" },
      },
      journal: {
        read: async () => {
          effects++;
          throw new Error("unexpected journal mutation path");
        },
      },
    };
    await assert.rejects(
      retainPipelineBuildResult(
        { source: f.source },
        { schema, outcome: "success" },
        session,
        f.host,
      ),
      /version/i,
    );
    assert.equal(effects, 0);
    assert.deepEqual(f.writes, []);
  }
});

test("a successful merge-group build with a wrong version lane emits no successful provider check", async () => {
  const f = fixture();
  f.contract.channels[1].to = "alpha/v2/v2.0";
  f.contract.channels[1].from = "dev/v2/v2.0";
  const context = {
    schema: "buildchain.pipeline-group-build-context/v1",
    source: f.source,
    branch: "alpha/v2/v2.0",
    baseCommit: "b".repeat(40),
    runId: 100,
    runAttempt: 1,
    platforms: [{ platform: "linux-x64" }],
  };
  Object.assign(f.host, {
    runId: 100,
    runAttempt: 1,
    runs: {
      read: async () => ({
        run: { event: "merge_group", head_sha: f.source.commit },
      }),
      build: async () => ({ outcome: "success" }),
    },
    queue: {
      getMergeQueueState: async () => ({
        enabled: true,
        entries: [{ headSha: f.source.commit, baseSha: context.baseCommit }],
      }),
    },
  });
  await assert.rejects(
    recordPipelineGroup(context, f.host),
    /publication version line/,
  );
  assert.deepEqual(f.writes, []);
});
