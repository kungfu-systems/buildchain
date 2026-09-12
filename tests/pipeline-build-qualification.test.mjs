import test from "node:test";
import assert from "node:assert/strict";
import { identities, runtime } from "./helpers/business-attempt.mjs";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import {
  qualifyPipelineBuild,
  verifyPipelineBuildQualification,
} from "../packages/core/workflow/pipeline/build-qualification.js";
import { qualifyRecoveryRuntime } from "../packages/core/workflow/pipeline/recovery-runtime.js";

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
