import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { recoveryBuildFixture } from "./helpers/pipeline-recovery.mjs";
import {
  beginRecoveryBuild,
  recordRecoveryBuild,
} from "../packages/core/workflow/pipeline/recovery-build-control.js";
import { guardPipelineBuild } from "../packages/core/workflow/pipeline/guard-build.js";
import {
  consumerWorkflows,
  RECOVERY_ENTRY,
} from "../packages/core/consumer/contract/entries.js";

test("native admission independently verifies recovered segments and the actual successful recovery caller", async () => {
  const f = await recoveryBuildFixture({ failed: [] });
  await recordRecoveryBuild(
    await beginRecoveryBuild(f.session, f.host),
    f.host,
  );
  const repository = f.host.repository;
  const run = {
    id: 300,
    run_attempt: 1,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_sha: "8".repeat(40),
    path: ".github/workflows/buildchain-recover.yml",
    referenced_workflows: [
      {
        path: `kungfu-systems/buildchain/${RECOVERY_ENTRY}@v4`,
        sha: "f".repeat(40),
      },
    ],
  };
  f.host.runs.read = async () => ({ run: structuredClone(run) });
  let bytes = Buffer.from(consumerWorkflows()[run.path]);
  const dependencies = {
    repository,
    material: f.host.materialStore(f.session),
    source: f.host.source,
    runs: f.host.runs,
    request: async () => ({
      type: "file",
      encoding: "base64",
      size: bytes.length,
      content: bytes.toString("base64"),
      sha: createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex"),
    }),
  };
  const input = { "source-workflow-run-id": 300 };
  assert.equal(
    (await guardPipelineBuild(input, f.observed(), dependencies)).outcome,
    "success",
  );
  await assert.rejects(
    guardPipelineBuild(
      { "source-workflow-run-id": 100 },
      f.observed(),
      dependencies,
    ),
    /exact product build/,
  );
  run.conclusion = "failure";
  await assert.rejects(
    guardPipelineBuild(input, f.observed(), dependencies),
    /exact PR generation/,
  );
  run.conclusion = "success";
  run.head_repository.full_name = "fork/consumer";
  await assert.rejects(
    guardPipelineBuild(input, f.observed(), dependencies),
    /fork boundary/,
  );
  run.head_repository.full_name = repository;
  bytes = Buffer.concat([bytes, Buffer.from("# changed caller\n")]);
  await assert.rejects(
    guardPipelineBuild(input, f.observed(), dependencies),
    /trusted minimal workflow/,
  );
});
