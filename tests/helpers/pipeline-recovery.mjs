import { pipelineHostFixture } from "./pipeline-host.mjs";
import { recordDigest } from "../../packages/core/release/discussion/envelope.js";
import { recordPipelineBuild } from "../../packages/core/workflow/pipeline/build-control.js";
import {
  selectRecoveryAttempt,
  openRecoveryAttempt,
} from "../../packages/core/workflow/pipeline/recovery-session.js";
import { qualifyRecoveryBuild } from "../../packages/core/workflow/pipeline/recovery-build.js";
import { planPipelineRecovery } from "../../packages/core/workflow/pipeline/recovery-plan.js";
import { resumePipelineSession } from "../../packages/core/workflow/pipeline/session.js";

export function productReadback(runId, source, platforms, failed = []) {
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

export async function recoveryBuildFixture({
  failed = ["windows-x64"],
  changedRuntime = false,
  open = true,
} = {}) {
  const f = pipelineHostFixture();
  f.admission.plan.products[0].platforms = ["linux-x64", "windows-x64"];
  const started = await f.event();
  const old = productReadback(
    100,
    f.f.source,
    ["linux-x64", "windows-x64"],
    failed,
  );
  const reads = [];
  const readbacks = new Map([[100, old]]);
  f.host.runs.build = async (id, attempt, source, platforms) => {
    reads.push({ id, attempt, source, platforms });
    return structuredClone(readbacks.get(id));
  };
  await recordPipelineBuild(started.context, f.host);
  if (!failed.length) {
    const session = await resumePipelineSession(
      { ...f.host, attempt: started.context.attempt },
      f.host,
    );
    await session.progress.progress({
      attempt: started.context.attempt,
      phase: "review",
      state: "cancelled",
      eventKey: "cancel-after-build",
    });
  }
  f.host.runId = 300;
  f.host.writer = { ...f.host.writer, runId: "300", jobId: "44" };
  f.host.runtime = { ...f.host.runtime, sha: "f".repeat(40) };
  const request = f.host.request;
  f.host.request = async (url, options) =>
    url.includes("/contents/")
      ? url.includes(".wasm")
        ? null
        : {
            type: "file",
            sha: (changedRuntime && url.endsWith(f.host.runtime.sha)
              ? "8"
              : "9"
            ).repeat(40),
          }
      : request(url, options);
  const entry = {
    repository: "kungfu-systems/buildchain",
    workflow: ".github/workflows/public-ops-recover.yml",
    sha: "f".repeat(40),
  };
  const selected = await selectRecoveryAttempt(
    started.context.attempt,
    f.host,
    entry,
  );
  const build = await qualifyRecoveryBuild(
    selected,
    { identity: f.f.source, plan: f.admission.plan },
    f.host,
  );
  const evidence = {
    build,
    admitted: {
      source: { identity: f.f.source, plan: f.admission.plan },
      admission: f.admission,
      caller: null,
    },
  };
  if (!open) return { ...f, selected, build, readbacks, reads, old, entry };
  const plan = planPipelineRecovery({
    observed: selected.observed,
    runtime: f.host.runtime,
    entry,
    evidenceRoot: recordDigest(evidence),
    nodes: selected.intent.expectedNodes.map((phase) => ({
      phase,
      operation: phase === "admission" ? "reuse" : "execute",
      reason: "Explicit qualified recovery",
      evidenceRoots: phase === "admission" ? [recordDigest(f.f.source)] : [],
    })),
  });
  const session = await openRecoveryAttempt(selected, plan, f.host, evidence);
  const source = await f.host
    .materialStore(session)
    .retain("source/admission", f.f.source);
  await session.progress.progress({
    attempt: session.observed.attempt,
    phase: "admission",
    state: "success",
    eventKey: "recovery-source-admission",
    materials: [source],
  });
  return { ...f, selected, session, build, readbacks, reads, old };
}
