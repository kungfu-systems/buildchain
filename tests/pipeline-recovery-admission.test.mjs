import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pipelineHostFixture } from "./helpers/pipeline-host.mjs";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";
import { selectRecoveryAttempt } from "../packages/core/workflow/pipeline/recovery-session.js";
import {
  recoveryExecution,
  admitRecoverySource,
  recoveryPredecessorRuns,
} from "../packages/core/workflow/pipeline/recovery-admission.js";

async function fixture() {
  const f = pipelineHostFixture();
  const started = await f.event();
  const definition = "f".repeat(40);
  const run = {
    id: 300,
    run_attempt: 1,
    event: "workflow_dispatch",
    status: "in_progress",
    head_sha: "8".repeat(40),
    path: ".github/workflows/buildchain-recover.yml",
    repository: { full_name: f.host.repository },
    head_repository: { full_name: f.host.repository },
    referenced_workflows: [
      {
        path: "kungfu-systems/buildchain/.github/workflows/public-ops-recover.yml@v4",
        sha: definition,
      },
    ],
  };
  const prior = { ...run, id: 100, status: "completed", conclusion: "failure" };
  f.host.runId = 300;
  f.host.writer = { ...f.host.writer, runId: "300", jobId: "44" };
  f.host.selection.source.repository = f.host.repository;
  f.host.runs.read = async (id) => ({
    run: structuredClone(id === 300 ? run : prior),
    jobs: [],
  });
  const bytes = Buffer.from(
    consumerWorkflows("v4", f.f.source.configPath)[
      ".github/workflows/buildchain-recover.yml"
    ],
  );
  const file = {
    type: "file",
    encoding: "base64",
    size: bytes.length,
    sha: createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex"),
    content: bytes.toString("base64"),
  };
  f.host.request = async () => structuredClone(file);
  const execution = await recoveryExecution(f.host, definition);
  const session = await selectRecoveryAttempt(
    started.context.attempt,
    f.host,
    execution.entry,
  );
  return { ...f, run, prior, file, execution, session, definition };
}

test("recovery authenticates its own published entry and exact caller before reading protected source intent", async () => {
  const f = await fixture();
  const admitted = await admitRecoverySource(f.session, f.execution, f.host);
  assert.deepEqual(admitted.source.identity, f.f.source);
  assert.equal(admitted.caller.blob, f.file.sha);
  assert.equal(
    (await recoveryPredecessorRuns(f.session, f.host)).terminal,
    true,
  );
  f.prior.status = "in_progress";
  f.prior.conclusion = null;
  assert.equal(
    (await recoveryPredecessorRuns(f.session, f.host)).terminal,
    false,
  );
});

test("recovery rejects foreign forks, untrusted entry refs and mismatched definition identities", async () => {
  const f = await fixture();
  f.run.head_repository.full_name = "fork/consumer";
  await assert.rejects(
    recoveryExecution(f.host, f.definition),
    /same consumer repository/,
  );
  f.run.head_repository.full_name = f.host.repository;
  await assert.rejects(
    recoveryExecution(f.host, "9".repeat(40)),
    /exact canonical entry/,
  );
  f.run.referenced_workflows[0].path =
    f.run.referenced_workflows[0].path.replace("@v4", "@feature/unreviewed");
  await assert.rejects(
    recoveryExecution(f.host, f.definition),
    /published floating channel/,
  );
  f.prior.head_repository = { full_name: "fork/consumer" };
  await assert.rejects(
    recoveryPredecessorRuns(f.session, f.host),
    /fork boundary/,
  );
});

test("recovery cannot borrow credentials through modified caller YAML or a changed source generation", async () => {
  const f = await fixture();
  const bytes = Buffer.from(
    Buffer.from(f.file.content, "base64").toString() + "# changed caller\n",
  );
  f.file.content = bytes.toString("base64");
  f.file.size = bytes.length;
  f.file.sha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  await assert.rejects(
    admitRecoverySource(f.session, f.execution, f.host),
    /trusted minimal workflow/,
  );
  const g = await fixture();
  g.admission.live.baseCommit = "7".repeat(40);
  await assert.rejects(
    admitRecoverySource(g.session, g.execution, g.host),
    /superseded or rebased/,
  );
  g.host.selection.source.sha = "6".repeat(40);
  await assert.rejects(
    admitRecoverySource(g.session, g.execution, g.host),
    /selected runtime source changed/,
  );
});
