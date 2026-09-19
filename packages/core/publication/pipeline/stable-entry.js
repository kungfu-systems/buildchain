import { recordDigest } from "../../release/discussion/envelope.js";
import { readBusinessAttempt } from "../../workflow/attempt/reader.js";
import { verifyRootedPublication } from "./documents.js";
import { verifyPipelinePublicationPlan } from "./plan.js";
import {
  pipelineEntryRuns,
  pipelineEntryRun,
  pipelineEntryCheck,
} from "../../providers/github/pipeline-entry-runs.js";

async function nativeBuild(check, run, consumer, host) {
  const loaded = await host.index.resolve(check.attempt);
  const observed = readBusinessAttempt(loaded.snapshot);
  const selected = observed.history.find(
    (item) => item.identity.id === check.attempt,
  );
  if (
    observed.intent.repository !== host.repository ||
    !selected ||
    selected.identity.requestKey.startsWith("recover:") ||
    recordDigest(selected.generation.source) !== recordDigest(consumer.source)
  )
    throw new Error(
      "Published entry check points to another source or a recovery attempt",
    );
  const phase = selected.phases.build;
  if (phase?.payload.state !== "success" || check.outcome !== "success")
    return {
      status: "missing",
      reason: "latest-published-entry-build-failed",
      attempt: check.attempt,
    };
  if (
    phase.payload.writer.runId !== String(run.id) ||
    phase.payload.writer.runAttempt !== String(run.run_attempt) ||
    phase.runtime.repository !== "kungfu-systems/buildchain" ||
    phase.runtime.sha !== consumer.selection.ref
  )
    throw new Error(
      "Published entry native build changed its actual runtime or execution",
    );
  const references = phase.payload.materials.filter((item) =>
    item.id.startsWith("build/provider-"),
  );
  if (references.length !== 1)
    throw new Error(
      "Published entry requires one original normal build receipt",
    );
  const session = {
    intent: loaded.snapshot.intent,
    observed: { ...observed, history: [selected] },
  };
  const readback = await host.materialStore(session).read(references[0]);
  verifyRootedPublication(readback, "buildchain.pipeline-build-readback/v1");
  if (
    readback.runId !== run.id ||
    readback.runAttempt !== run.run_attempt ||
    readback.outcome !== "success" ||
    recordDigest(readback.source) !== recordDigest(consumer.source) ||
    recordDigest(readback.entry) !== recordDigest(consumer.entry) ||
    check.summary !==
      `Exact product jobs: ${readback.root}\nAttempt: ${check.attempt}`
  )
    throw new Error("Published entry check and native build material disagree");
  return {
    readback,
    phase,
    reference: references[0],
    attempt: check.attempt,
    intent: observed.intent.id,
  };
}

function completion(run, jobs, native, source) {
  const recorder = jobs.filter(
    (job) => String(job.id) === native.phase.payload.writer.jobId,
  );
  if (
    recorder.length !== 1 ||
    recorder[0].status !== "completed" ||
    recorder[0].conclusion !== "success" ||
    recorder[0].run_id !== run.id ||
    recorder[0].run_attempt !== run.run_attempt ||
    !(
      recorder[0].name === "Record product build" ||
      recorder[0].name.endsWith(" / Record product build")
    )
  )
    throw new Error(
      "Published entry native receipt lacks its exact completed recorder job",
    );
  const selected = [...native.readback.jobs, recorder[0]];
  const start = Date.parse(source.candidate.publishedAt),
    completions = [];
  for (const job of selected) {
    const started = Date.parse(job.started_at),
      ended = Date.parse(job.completed_at);
    if (
      !Number.isFinite(started) ||
      !Number.isFinite(ended) ||
      started < start ||
      ended < started
    )
      throw new Error(
        "Published entry jobs must execute after the exact Alpha publication",
      );
    completions.push(ended);
  }
  return new Date(Math.max(...completions)).toISOString();
}

async function inspectEntryRun(listed, plan, source, host) {
  const { run, jobs } = await host.runs.read(listed.id, listed.run_attempt);
  const consumer = await pipelineEntryRun(run, plan, source, host);
  if (!consumer) return null;
  if (
    !jobs.some((job) => /(?:^| \/ )Build product \([^)]+\)$/u.test(job.name)) &&
    run.conclusion === "success"
  )
    return null;
  const check = await pipelineEntryCheck(run, host);
  if (!check)
    return {
      status: "missing",
      reason: "latest-published-entry-build-unrecorded",
      runId: run.id,
    };
  const native = await nativeBuild(check, run, consumer, host);
  if (native.status === "missing") return native;
  const platforms = [
    ...new Set(plan.outputs.map(({ platform }) => platform)),
  ].sort();
  const fresh = await host.runs.build(
    run.id,
    run.run_attempt,
    consumer.source,
    platforms,
  );
  if (recordDigest(fresh) !== recordDigest(native.readback))
    throw new Error(
      "Published entry original jobs changed or omit declared platforms",
    );
  const completedAt = completion(run, jobs, native, source);
  const again = await host.runs.read(run.id, run.run_attempt);
  const repeated = await nativeBuild(
    await pipelineEntryCheck(again.run, host),
    again.run,
    consumer,
    host,
  );
  if (
    recordDigest(repeated) !== recordDigest(native) ||
    recordDigest(again) !== recordDigest({ run, jobs })
  )
    throw new Error(
      "Published entry evidence changed during final provider readback",
    );
  const body = {
    schema: "buildchain.pipeline-stable-entry/v1",
    planRoot: plan.root,
    sourceRoot: source.root,
    consumer,
    native,
    runId: run.id,
    runAttempt: run.run_attempt,
    canary: {
      id: "published-entry",
      source: "public-build",
      status: "success",
      repository: host.repository,
      candidateSha: source.candidate.sha,
      completedAt,
      attestor: "github-actions[bot]",
      runtimeRef: consumer.selection.ref,
      evidenceUrl: `https://github.com/${host.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`,
    },
  };
  return { ...body, root: recordDigest(body) };
}

export async function readPipelineStableEntry(plan, source, host) {
  verifyPipelinePublicationPlan(plan);
  verifyRootedPublication(source, "buildchain.pipeline-stable-source/v1");
  if (
    plan.channel !== "stable" ||
    source.planRoot !== plan.root ||
    host.repository !== plan.source.repository ||
    source.contractRoot !== plan.contractRoot ||
    source.candidate.sha !== plan.intentSource.commit ||
    !Number.isFinite(Date.parse(source.candidate.publishedAt))
  )
    throw new Error(
      "Published entry collection requires its exact admitted Alpha plan",
    );
  const inventory = await pipelineEntryRuns(host, source.candidate.publishedAt);
  for (const run of inventory) {
    const result = await inspectEntryRun(run, plan, source, host);
    if (result) {
      if (
        result.canary &&
        recordDigest(
          await pipelineEntryRuns(host, source.candidate.publishedAt),
        ) !== recordDigest(inventory)
      )
        throw new Error(
          "Published entry run inventory changed during qualification",
        );
      return result;
    }
  }
  return {
    status: "missing",
    reason: "no-normal-published-entry-build-for-exact-runtime",
  };
}
