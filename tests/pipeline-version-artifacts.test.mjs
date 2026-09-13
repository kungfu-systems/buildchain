import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";
import { pipelineVersionRegenerationResult } from "../packages/core/publication/pipeline/version-regeneration.js";
import { githubPipelineVersionArtifacts } from "../packages/core/providers/github/pipeline-version-artifacts.js";
import {
  pipelineVersionArtifactName,
  pipelineVersionJobName,
  readPipelineVersionBuild,
} from "../packages/core/providers/github/pipeline-version-readback.js";

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipeline-version-artifact-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = "example/product";
  const preparation = {
    root: `sha256:${"a".repeat(64)}`,
    source: {
      repository,
      commit: "c".repeat(40),
      configPath: ".buildchain/buildchain.toml",
    },
    runtime: { repository: "kungfu-systems/buildchain", sha: "d".repeat(40) },
    versionPolicy: {
      files: [{ path: "package.json", format: "json", key: "version" }],
    },
    version: "1.0.0",
    platforms: ["linux-x64", "windows-x64"],
    purpose: "publication",
  };
  const context = {
    preparation,
    runId: 8,
    runAttempt: 2,
    definitionSha: "e".repeat(40),
  };
  const run = {
    id: 8,
    run_attempt: 2,
    head_sha: "b".repeat(40),
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    event: "repository_dispatch",
    path: ".github/workflows/buildchain.yml",
    referenced_workflows: [
      {
        path: "kungfu-systems/buildchain/.github/workflows/public-ops-pipeline.yml@v4",
        sha: "f".repeat(40),
      },
      {
        path: "kungfu-systems/buildchain/.github/workflows/.release-pipeline-products.yml@v4",
        sha: context.definitionSha,
      },
      {
        path: "kungfu-systems/buildchain/.github/workflows/.release-pipeline-version.yml@v4",
        sha: context.definitionSha,
      },
    ],
  };
  const bytes = Buffer.from(consumerWorkflows()[run.path]);
  const caller = {
    type: "file",
    encoding: "base64",
    content: bytes.toString("base64"),
    size: bytes.length,
    sha: createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex"),
  };
  const jobs = preparation.platforms.map((platform, index) => ({
    id: index + 1,
    name: `Products / ${pipelineVersionJobName(preparation, platform)}`,
    run_id: 8,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
  }));
  const artifacts = preparation.platforms.map((platform, index) => ({
    id: 10 + index,
    name: pipelineVersionArtifactName(context, platform),
    expired: false,
    digest: `sha256:${"c".repeat(64)}`,
    workflow_run: { id: 8, head_sha: run.head_sha },
  }));
  const state = {
    run,
    jobs,
    artifacts,
    total_count: 2,
    downloads: [],
    mismatch: false,
    extra: false,
    alter: (result) => result,
    reads: 0,
  };
  const host = {
    repository,
    token: "test",
    request: async (url) =>
      url.includes("/contents/")
        ? caller
        : { artifacts: state.artifacts, total_count: state.total_count },
    runs: {
      read: async () => {
        state.reads++;
        return structuredClone({ run: state.run, jobs: state.jobs });
      },
    },
  };
  const client = {
    downloadArtifact: async (id, options) => {
      state.downloads.push({ id, options });
      const result = pipelineVersionRegenerationResult(
        preparation,
        preparation.platforms[id - 10],
        { "package.json": '{"version":"1.0.0"}' },
      );
      fs.writeFileSync(
        path.join(options.path, "version.json"),
        JSON.stringify(state.alter(result)),
      );
      if (state.extra)
        fs.writeFileSync(path.join(options.path, "control.sh"), "unexpected");
      return { digestMismatch: state.mismatch };
    },
  };
  return {
    state,
    context,
    host,
    directory,
    provider: githubPipelineVersionArtifacts(host, client),
  };
}

test("version artifacts bind actual successful jobs, exact workflow definition and downloaded provider digests", async (t) => {
  const { state, context, provider, directory } = fixture(t);
  const result = await provider.download(context, directory);
  assert.equal(result.build.source.commit, context.preparation.source.commit);
  assert.equal(state.reads, 2);
  assert.deepEqual(
    result.results.map(({ platform }) => platform),
    context.preparation.platforms,
  );
  for (const { id, options } of state.downloads) {
    assert.equal(
      options.expectedHash,
      state.artifacts.find((value) => value.id === id).digest,
    );
    assert.equal(options.findBy.workflowRunId, context.runId);
  }
});

test("version artifact admission rejects stale, partial, duplicate and unrelated producers before downloading", async (t) => {
  for (const alter of [
    (s) => {
      s.jobs[0].conclusion = "failure";
    },
    (s) => {
      s.jobs[0].run_attempt = 1;
    },
    (s) => {
      s.jobs.push(s.jobs[0]);
    },
    (s) => {
      s.artifacts[0].expired = true;
    },
    (s) => {
      s.artifacts[0].workflow_run.head_sha = "9".repeat(40);
    },
    (s) => {
      s.artifacts[0].name = s.artifacts[0].name.replace("-8-2-", "-8-1-");
    },
    (s) => {
      s.total_count++;
    },
    (s) => {
      s.run.referenced_workflows[1].sha = "9".repeat(40);
    },
    (s) => {
      s.run.head_repository.full_name = "unrelated/fork";
    },
  ]) {
    const { state, context, provider, directory } = fixture(t);
    alter(state);
    await assert.rejects(
      provider.download(context, directory),
      /Version preparation|fork boundary/,
    );
    assert.deepEqual(state.downloads, []);
  }
});

test("version artifact transport rejects mismatched bytes, extra files, platform substitution and producer races", async (t) => {
  for (const alter of [
    (s) => {
      s.mismatch = true;
    },
    (s) => {
      s.extra = true;
    },
    (s) => {
      s.alter = (result) => ({ ...result, platform: "unrelated" });
    },
    (s) => {
      s.alter = (result) => ({
        ...result,
        files: { "package.json": "changed" },
      });
    },
  ]) {
    const { state, context, provider, directory } = fixture(t);
    alter(state);
    await assert.rejects(
      provider.download(context, directory),
      /Version download|Version artifact/,
    );
  }
  const { state, context, host } = fixture(t);
  const read = host.runs.read;
  host.runs.read = async () => {
    if (state.reads) state.jobs[0].conclusion = "cancelled";
    return read();
  };
  await assert.rejects(
    readPipelineVersionBuild(context, host),
    /changed during independent readback/,
  );
});
