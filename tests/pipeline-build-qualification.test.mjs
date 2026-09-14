import test from "node:test";
import assert from "node:assert/strict";
import { identities, runtime } from "./helpers/business-attempt.mjs";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import {
  qualifyPipelineBuild,
  verifyPipelineBuildQualification,
} from "../packages/core/workflow/pipeline/build-qualification.js";
import { qualifyRecoveryRuntime } from "../packages/core/workflow/pipeline/recovery-runtime.js";
import {
  publishPipelineBuildCheck,
  observePipelineBuildChecks,
} from "../packages/core/workflow/pipeline/build-evidence.js";

test("check repair rejects source and execution drift and leaves unrelated checks untouched", async () => {
  const { source, attempt } = identities();
  const check = {
    id: 17,
    name: "check",
    head_sha: source.commit,
    app: { slug: "github-actions" },
    conclusion: "success",
    external_id: `buildchain:${attempt.id}:100:1`,
  };
  const request = async (url) =>
    url.includes("/check-runs?")
      ? { check_runs: [check] }
      : {
          id: 100,
          run_attempt: 1,
          event: "workflow_dispatch",
          repository: { full_name: "foreign/repo" },
        };
  await assert.rejects(
    observePipelineBuildChecks(source, request, source.repository),
    /execution identity/,
  );
  check.head_sha = "f".repeat(40);
  await assert.rejects(
    observePipelineBuildChecks(source, request, source.repository),
    /provider identity/,
  );
  check.app.slug = "other-app";
  assert.deepEqual(
    await observePipelineBuildChecks(source, request, source.repository),
    { renames: [], eligible: [] },
  );
});

test("recovery checks cannot shadow eligible source checks and retain the original verification evidence", async () => {
  const f = identities();
  const context = {
    source: f.source,
    attempt: f.attempt.id,
    runId: 200,
    runAttempt: 1,
  };
  const readback = qualifyPipelineBuild({
    source: f.source,
    platforms: ["linux-x64"],
    runId: 200,
    runAttempt: 1,
    segments: [
      {
        readback: result(100, f.source, ["linux-x64"]),
        platforms: ["linux-x64"],
        runtime,
      },
    ],
  });
  const checks = [100, 150].map((id) => ({
    id,
    name: "check",
    head_sha: f.source.commit,
    app: { slug: "github-actions" },
    conclusion: "success",
    external_id: `buildchain:${f.attempt.id}:${id}:1`,
  }));
  const effects = [];
  const request = async (url, options) => {
    if (options?.method === "PATCH") {
      effects.push({ url, body: options.body });
      return {};
    }
    if (options?.method === "POST") {
      effects.push({ url, body: options.body });
      return {};
    }
    if (url.includes("/check-runs?"))
      return { total_count: checks.length, check_runs: checks };
    const id = Number(url.match(/runs\/(\d+)/)[1]);
    return {
      id,
      run_attempt: 1,
      head_sha: f.source.commit,
      event: id === 100 ? "pull_request" : "workflow_dispatch",
      repository: { full_name: f.source.repository },
    };
  };
  await publishPipelineBuildCheck(
    context,
    readback,
    request,
    f.source.repository,
  );
  assert.equal(effects.length, 2);
  assert.deepEqual(effects[0], {
    url: `/repos/${f.source.repository}/check-runs/150`,
    body: { name: "Buildchain recovery verification" },
  });
  assert.equal(effects[1].body.name, "Buildchain recovery verification");
  assert.equal(effects[1].body.conclusion, "success");
  assert.ok(effects[1].body.output.summary.includes(readback.root));
  effects.length = 0;
  const normal = result(200, f.source, ["linux-x64"]);
  await publishPipelineBuildCheck(
    context,
    normal,
    request,
    f.source.repository,
  );
  assert.equal(effects.length, 1);
  assert.equal(effects[0].body.name, "check");
  effects.length = 0;
  checks[0].conclusion = "failure";
  const before = structuredClone(readback);
  await publishPipelineBuildCheck(
    context,
    readback,
    request,
    f.source.repository,
  );
  assert.equal(effects.length, 3);
  assert.equal(effects[1].url, `/repos/${f.source.repository}/check-runs/100`);
  assert.equal(effects[1].body.conclusion, "success");
  assert.equal(
    effects[1].body.output.title,
    "Buildchain recovered product verification",
  );
  assert.ok(effects[1].body.output.summary.includes(readback.root));
  assert.deepEqual(readback, before);
  effects.length = 0;
  const changedSource = {
    ...context,
    source: { ...context.source, commit: "f".repeat(40) },
  };
  await assert.rejects(
    publishPipelineBuildCheck(
      changedSource,
      readback,
      request,
      f.source.repository,
    ),
    /source differs/,
  );
  assert.equal(effects.length, 0);
});

test("full replacement recovery projects its required check without rewriting failed original execution", async () => {
  const { source, attempt } = identities();
  const context = { source, attempt: attempt.id, runId: 200, runAttempt: 1 };
  const original = {
    id: 17,
    name: "check",
    head_sha: source.commit,
    app: { slug: "github-actions" },
    conclusion: "failure",
    external_id: `buildchain:${attempt.id}:100:1`,
  };
  for (const inventory of [[original], []]) {
    for (const failed of [[], ["linux-x64"]]) {
      const readback = qualifyPipelineBuild({
        source,
        platforms: ["linux-x64"],
        runId: 200,
        runAttempt: 1,
        segments: [
          {
            readback: result(200, source, ["linux-x64"], failed),
            platforms: ["linux-x64"],
            runtime,
          },
        ],
      });
      const effects = [];
      const request = async (url, options) => {
        if (options) {
          effects.push({ url, ...options });
          return {};
        }
        if (url.includes("/check-runs?")) return { check_runs: inventory };
        return {
          id: 100,
          run_attempt: 1,
          event: "pull_request",
          head_sha: source.commit,
          repository: { full_name: source.repository },
        };
      };
      const before = structuredClone({ original, readback });
      await publishPipelineBuildCheck(
        context,
        readback,
        request,
        source.repository,
      );
      assert.equal(effects.length, 1);
      assert.equal(effects[0].method, "POST");
      assert.equal(effects[0].body.name, "check");
      assert.equal(effects[0].body.head_sha, source.commit);
      assert.equal(
        effects[0].body.conclusion,
        failed.length ? "failure" : "success",
      );
      assert.ok(effects[0].body.output.summary.includes(readback.root));
      assert.deepEqual({ original, readback }, before);
    }
  }
});

function result(runId, source, platforms, failed = []) {
  const body = {
    schema: "buildchain.pipeline-build-readback/v1",
    source,
    runId,
    runAttempt: 1,
    entry: {
      path: "kungfu-systems/buildchain/.github/workflows/public-ops-pipeline.yml@v4",
      sha: "a".repeat(40),
    },
    jobs: platforms.map((platform, index) => ({
      id: runId * 10 + index,
      run_id: runId,
      run_attempt: 1,
      name: `Build product (${platform})`,
      status: "completed",
      conclusion: failed.includes(platform) ? "failure" : "success",
    })),
    outcome: failed.length ? "failure" : "success",
  };
  return { ...body, root: recordDigest(body) };
}

test("partial platform recovery combines original Linux verification with only the repaired Windows execution", async () => {
  const { source } = identities(),
    platforms = ["linux-x64", "windows-x64"];
  const old = result(100, source, platforms, ["windows-x64"]),
    repaired = result(200, source, ["windows-x64"]);
  const value = qualifyPipelineBuild({
    source,
    platforms,
    runId: 200,
    runAttempt: 1,
    segments: [
      { readback: old, platforms: ["linux-x64"], runtime },
      { readback: repaired, platforms: ["windows-x64"], runtime },
    ],
  });
  const reads = [];
  const runs = {
    build: async (id) => {
      reads.push(id);
      return id === 100 ? old : repaired;
    },
  };
  assert.equal(
    (await verifyPipelineBuildQualification(value, source, platforms, runs))
      .outcome,
    "success",
  );
  assert.deepEqual(reads, [100, 200]);
  assert.equal(old.outcome, "failure");
  await assert.rejects(
    verifyPipelineBuildQualification(value, source, platforms, {
      build: async () => repaired,
    }),
    /provider requalification/,
  );
  assert.throws(
    () =>
      qualifyPipelineBuild({ ...value, segments: value.segments.slice(0, 1) }),
    /missing declared/,
  );
  assert.throws(
    () =>
      qualifyPipelineBuild({
        ...value,
        segments: [...value.segments, value.segments[0]],
      }),
    /duplicated/,
  );
});

test("recovery stage reuse compares actual distributed runtime closures and rejects missing implementation", async () => {
  const repaired = { ...runtime, sha: "f".repeat(40) };
  let changed = false;
  const request = async (url) =>
    url.includes(".wasm")
      ? null
      : {
          type: "file",
          sha: (changed && url.endsWith(repaired.sha) ? "8" : "9").repeat(40),
        };
  assert.equal(
    (await qualifyRecoveryRuntime(runtime, repaired, "build", request))
      .compatible,
    true,
  );
  changed = true;
  assert.equal(
    (await qualifyRecoveryRuntime(runtime, repaired, "build", request))
      .compatible,
    false,
  );
  await assert.rejects(
    qualifyRecoveryRuntime(runtime, repaired, "build", async () => null),
    /distributed stage/,
  );
  await assert.rejects(
    qualifyRecoveryRuntime(
      runtime,
      { ...runtime, readerDigest: recordDigest("changed") },
      "build",
      request,
    ),
    /immutable reader/,
  );
});
