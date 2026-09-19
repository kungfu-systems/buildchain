import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubPipelineNativeResults } from "../packages/core/providers/github/pipeline-native-results.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

function fixture() {
  const operation = {
    authority: {
      repository: "kungfu-systems/buildchain",
      entrySha: "a".repeat(40),
    },
    runtimeSha: "b".repeat(40),
    requestRoot: recordDigest("requests"),
    source: { repository: "example/product", runId: 12 },
    correlationId: "operation-12-1",
    resultArtifact: "signed-result-12-1",
    requestIds: ["cli-macos-arm64-archive", "app-macos-arm64-zip"],
  };
  const run = {
    id: 34,
    run_attempt: 1,
    repository: { full_name: "kungfu-systems/buildchain" },
    path: ".github/workflows/public-release-signing-authority.yml",
    event: "workflow_dispatch",
    head_sha: operation.authority.entrySha,
    display_title: "Sign example/product run 12 (operation-12-1)",
    status: "completed",
    conclusion: "success",
  };
  const jobs = [
    "Admit immutable signing requests",
    ...operation.requestIds.map((id) => `Developer ID ${id}`),
    "Publish immutable signed result set",
  ].map((name, index) => ({
    id: index + 1,
    name,
    run_id: 34,
    run_attempt: 1,
    head_sha: run.head_sha,
    status: "completed",
    conclusion: "success",
  }));
  const artifact = {
    id: 56,
    name: operation.resultArtifact,
    digest: recordDigest("archive"),
    expired: false,
    workflow_run: { id: 34, head_sha: run.head_sha },
  };
  const state = {
    operation,
    run,
    jobs,
    artifacts: [artifact],
    total: 1,
    reads: 0,
  };
  const request = async (url) => {
    if (url.endsWith("/actions/runs/34")) {
      state.reads++;
      state.onRun?.();
      return structuredClone(state.run);
    }
    if (url.endsWith("/attempts/1/jobs?per_page=100&page=1"))
      return { jobs: structuredClone(state.jobs) };
    if (url.endsWith("/artifacts?per_page=100"))
      return {
        total_count: state.total,
        artifacts: structuredClone(state.artifacts),
      };
    throw new Error(`unexpected request: ${url}`);
  };
  state.provider = (client) =>
    githubPipelineNativeResults({ request, token: "fixture", client });
  return state;
}

test("native result readback independently binds dispatch, jobs, runtime and immutable artifact", async () => {
  const f = fixture();
  const proof = await f.provider().readback(f.operation, 34, 1);
  assert.equal(proof.operationRoot, recordDigest(f.operation));
  assert.equal(proof.runtimeSha, f.operation.runtimeSha);
  assert.equal(proof.artifact.id, 56);
  assert.equal(proof.jobs.length, 4);
  assert.equal(f.reads, 2);
});

test("successful native run cannot substitute another workflow, execution, job or artifact", async () => {
  const mutations = [
    (f) => {
      f.run.repository = {};
    },
    (f) => {
      f.run.path = ".github/workflows/untrusted.yml";
    },
    (f) => {
      f.run.head_sha = "c".repeat(40);
    },
    (f) => {
      f.run.event = "push";
    },
    (f) => {
      f.run.display_title += "-other";
    },
    (f) => {
      f.run.run_attempt = 2;
    },
    (f) => {
      f.jobs[1].conclusion = "skipped";
    },
    (f) => {
      f.jobs[1].head_sha = "c".repeat(40);
    },
    (f) => {
      f.jobs[1].run_attempt = 2;
    },
    (f) => {
      f.jobs.push(structuredClone(f.jobs[1]));
    },
    (f) => {
      f.jobs[1].id = f.jobs[0].id;
    },
    (f) => {
      f.artifacts[0].expired = true;
    },
    (f) => {
      f.artifacts[0].workflow_run.head_sha = "c".repeat(40);
    },
    (f) => {
      delete f.artifacts[0].digest;
    },
    (f) => {
      f.artifacts.push(structuredClone(f.artifacts[0]));
      f.total++;
    },
    (f) => {
      f.total++;
    },
    (f) => {
      f.operation.requestIds.push(f.operation.requestIds[0]);
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await assert.rejects(
      f.provider().readback(f.operation, 34, 1),
      /Native|Pipeline/,
    );
  }
});

test("native provider changes during readback cannot be retained as successful proof", async () => {
  const f = fixture();
  f.onRun = () => {
    if (f.reads === 2) f.jobs[1].id = 999;
  };
  await assert.rejects(
    f.provider().readback(f.operation, 34, 1),
    /changed during/,
  );
});

test("qualified native bytes retain their original jobs after temporary artifacts expire", async () => {
  const f = fixture();
  const provider = f.provider();
  const proof = await provider.readback(f.operation, 34, 1);
  f.artifacts[0].expired = true;
  await assert.rejects(
    provider.readback(f.operation, 34, 1),
    /immutable result artifact/,
  );
  assert.deepEqual(await provider.reobserve(f.operation, proof), proof);
  f.jobs[1].id = 999;
  await assert.rejects(provider.reobserve(f.operation, proof), /jobs changed/);
});

test("native download checks provider digest, fresh directory and post-transfer authority", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-provider-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const scenario of ["success", "bad-digest", "replaced-artifact"]) {
    const f = fixture();
    const provider = f.provider({
      downloadArtifact: async (id, options) => {
        assert.equal(id, 56);
        assert.equal(options.expectedHash, f.artifacts[0].digest);
        assert.deepEqual(fs.readdirSync(options.path), []);
        assert.equal(options.findBy.workflowRunId, 34);
        fs.writeFileSync(path.join(options.path, "index.json"), "fixture");
        if (scenario === "replaced-artifact") f.artifacts[0].id = 57;
        return { digestMismatch: scenario === "bad-digest" };
      },
    });
    const result = provider.download(f.operation, 34, 1, directory);
    if (scenario === "success") {
      const downloaded = await result;
      assert.ok(fs.existsSync(path.join(downloaded.directory, "index.json")));
      assert.equal(f.reads, 4);
    } else
      await assert.rejects(
        result,
        /download differs|changed while downloading/,
      );
  }
});
