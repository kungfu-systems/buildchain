import { recordPipelineBuildAction } from "./actions.js";
import { pipelineHost } from "./host.js";
import { resumePipelineSession } from "./session.js";
import { pipelineBuildEvidence } from "./build-evidence.js";
import { buildReadbackPlatforms } from "./build-qualification.js";
import { pipelinePlatforms } from "./platforms.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import { pipelineRunEntry } from "../../providers/github/pipeline-run-entry.js";

function recordedJob(run, jobs, host) {
  const current = run.id === host.runId && run.run_attempt === host.runAttempt;
  if (!current && (run.status !== "completed" || run.conclusion !== "success"))
    throw new Error("Original recorder run did not complete successfully");
  const matches = jobs.filter((job) =>
    /(?:^| \/ )(?:Record product build|check)$/u.test(job.name),
  );
  if (matches.length !== 1)
    throw new Error("Recorder check needs one original aggregate job");
  const job = matches[0];
  if (
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    (current
      ? job.id !== Number(host.writer.jobId) || job.status !== "in_progress"
      : job.status !== "completed" || job.conclusion !== "success")
  )
    throw new Error("Recorder check changed its exact provider job");
  return job;
}

function verifyRecordedCheck(before, suite, run, job, source) {
  if (
    before.id !== job.id ||
    before.app?.id !== 15368 ||
    before.head_sha !== source.commit ||
    before.check_suite?.id !== run.check_suite_id ||
    before.status !== job.status ||
    before.conclusion !== job.conclusion ||
    suite.id !== run.check_suite_id ||
    suite.app?.id !== 15368 ||
    suite.head_sha !== source.commit ||
    (run.event === "pull_request" &&
      !suite.pull_requests?.some(
        (pr) =>
          pr.head?.sha === source.commit &&
          pr.head?.repo?.id === run.repository?.id,
      ))
  )
    throw new Error(
      "Recorder check has a different App, source, outcome or PR suite",
    );
}

// GitHub may attach a separately created check to an unrelated Actions suite.
// Use the real aggregate job in the eligible source run, preserving its outcome.
export async function projectRecordedPipelineCheck(source, readback, host) {
  const declared = await host.source.source(source.commit, source.configPath);
  if (
    recordDigest(declared.identity) !== recordDigest(source) ||
    readback.outcome !== "success" ||
    recordDigest(readback.source) !== recordDigest(source)
  )
    throw new Error("Recorder check requires the exact successful source");
  const platforms = pipelinePlatforms(declared.plan)
    .map(({ platform }) => platform)
    .sort();
  const candidates = readback.segments?.map(({ readback: value }) => value) || [
    readback,
  ];
  for (const candidate of candidates) {
    if (
      candidate.outcome !== "success" ||
      recordDigest(buildReadbackPlatforms(candidate).sort()) !==
        recordDigest(platforms)
    )
      continue;
    const verified = await host.runs.build(
      candidate.runId,
      candidate.runAttempt,
      source,
      platforms,
    );
    if (recordDigest(verified) !== recordDigest(candidate))
      throw new Error("Recorder check provider build changed");
    const { run, jobs } = await host.runs.read(
      candidate.runId,
      candidate.runAttempt,
    );
    if (!["pull_request", "merge_group"].includes(run.event)) continue;
    if (run.head_sha !== source.commit || pipelineRunEntry(run).recovery)
      throw new Error("Recorder check is not an eligible exact source run");
    const job = recordedJob(run, jobs, host);
    const base = `/repos/${host.repository}`;
    const checkPath = `${base}/check-runs/${job.id}`;
    if (job.check_run_url !== `https://api.github.com${checkPath}`)
      throw new Error("Recorder check URL does not identify its provider job");
    const before = await host.request(checkPath);
    const suite = await host.request(
      `${base}/check-suites/${run.check_suite_id}`,
    );
    verifyRecordedCheck(before, suite, run, job, source);
    // Never write success, timestamps, head SHA, external ID or a replacement job.
    const after = await host.request(checkPath, {
      method: "PATCH",
      body: { name: "check" },
    });
    if (
      after.id !== before.id ||
      after.name !== "check" ||
      after.status !== before.status ||
      after.conclusion !== before.conclusion ||
      after.head_sha !== before.head_sha ||
      after.app?.id !== before.app.id ||
      after.check_suite?.id !== before.check_suite.id ||
      after.external_id !== before.external_id
    )
      throw new Error(
        "Recorder check metadata update changed provider execution evidence",
      );
    return { runId: run.id, runAttempt: run.run_attempt, before, after };
  }
  return null;
}

export async function recordPipelineCheckAction(core, env) {
  await recordPipelineBuildAction(core, env);
  const context = JSON.parse(core.getInput("context", { required: true }));
  if (context.schema === "buildchain.pipeline-group-build-context/v1") return;
  const host = await pipelineHost(core, env, "Record product build");
  const session = await resumePipelineSession(
    { ...host, attempt: context.attempt },
    host,
  );
  const evidence = await pipelineBuildEvidence(session, host);
  if (!evidence || evidence.outcome !== "success")
    throw new Error(
      "Recorder check requires retained successful build evidence",
    );
  const projection = await projectRecordedPipelineCheck(
    context.source,
    evidence.readback,
    host,
  );
  if (projection) {
    const material = await host
      .materialStore(session)
      .retain(
        `build/recorder-check-${projection.runId}-${projection.runAttempt}`,
        projection,
        "provider-readback",
      );
    core.info(`Qualified recorder check: ${JSON.stringify(material)}`);
  } else
    core.info(
      "No complete original source recorder is eligible for check projection",
    );
}
