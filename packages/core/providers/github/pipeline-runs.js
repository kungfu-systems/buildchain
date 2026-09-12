import { providerWriter } from "../../workflow/attempt/identity.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import { PIPELINE_ENTRY } from "../../consumer/contract/entries.js";

function uniqueJob(jobs, name) {
  const matches = jobs.filter(
    (job) => job.name === name || job.name.endsWith(` / ${name}`),
  );
  if (matches.length !== 1)
    throw new Error(`Pipeline needs one exact provider job: ${name}`);
  return matches[0];
}

export function githubPipelineRuns(request, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository || ""))
    throw new Error("Invalid pipeline run repository");
  const base = `/repos/${repository}`;
  async function read(runId, runAttempt) {
    for (const value of [runId, runAttempt])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Invalid pipeline run coordinates");
    const run = await request(`${base}/actions/runs/${runId}`);
    if (
      run.id !== runId ||
      run.run_attempt !== runAttempt ||
      run.repository?.full_name !== repository
    )
      throw new Error("Pipeline provider run attempt changed");
    const jobs = [];
    for (let page = 1; page <= 100; page++) {
      const response = await request(
        `${base}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`,
      );
      if (!Array.isArray(response.jobs))
        throw new Error("Missing pipeline provider jobs");
      jobs.push(...response.jobs);
      if (response.jobs.length < 100) return { run, jobs };
    }
    throw new Error("Pipeline job inventory exceeds its bound");
  }
  async function writer(runId, runAttempt, jobName) {
    const { jobs } = await read(runId, runAttempt);
    const job = uniqueJob(jobs, jobName);
    if (
      job.run_id !== runId ||
      job.run_attempt !== runAttempt ||
      job.status !== "in_progress"
    )
      throw new Error("Pipeline writer is not the exact active provider job");
    const value = {
      repository,
      runId: String(runId),
      runAttempt: String(runAttempt),
      jobId: String(job.id),
    };
    providerWriter(value, repository);
    return value;
  }
  async function build(runId, runAttempt, source, platforms) {
    const { run, jobs } = await read(runId, runAttempt);
    if (
      ![
        "pull_request",
        "repository_dispatch",
        "pull_request_review",
        "merge_group",
      ].includes(run.event) ||
      (["pull_request", "merge_group"].includes(run.event) &&
        run.head_sha !== source.commit) ||
      source.repository !== repository
    )
      throw new Error("Build provider run does not match admitted PR source");
    const entries = (run.referenced_workflows || []).filter((entry) =>
      entry.path?.startsWith(`kungfu-systems/buildchain/${PIPELINE_ENTRY}@`),
    );
    if (entries.length !== 1 || !/^[0-9a-f]{40}$/u.test(entries[0].sha || ""))
      throw new Error("Build provider run has no exact pipeline entry");
    if (
      !Array.isArray(platforms) ||
      !platforms.length ||
      new Set(platforms).size !== platforms.length
    )
      throw new Error(
        "Build provider receipt requires declared unique platforms",
      );
    const selected = platforms.map((platform) =>
      uniqueJob(jobs, `Build product (${platform})`),
    );
    if (
      selected.some(
        (job) =>
          job.run_id !== runId ||
          job.run_attempt !== runAttempt ||
          job.status !== "completed" ||
          !job.conclusion,
      )
    )
      throw new Error("Product build jobs are not provider-terminal");
    const again = await request(`${base}/actions/runs/${runId}`);
    if (
      again.id !== run.id ||
      again.run_attempt !== runAttempt ||
      again.head_sha !== run.head_sha
    )
      throw new Error("Product build run changed during readback");
    const body = {
      schema: "buildchain.pipeline-build-readback/v1",
      source,
      runId,
      runAttempt,
      entry: entries[0],
      jobs: selected,
      outcome: selected.every((job) => job.conclusion === "success")
        ? "success"
        : "failure",
    };
    return { ...body, root: recordDigest(body) };
  }
  async function completed(
    runId,
    runAttempt,
    { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
  ) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const { run } = await read(runId, runAttempt);
      if (run.status === "completed") return run;
      await sleep(3000);
    }
    throw new Error(
      "Predecessor workflow did not become terminal within the bounded provider readback window",
    );
  }
  return { read, writer, build, completed };
}
