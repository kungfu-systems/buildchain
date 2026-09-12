import { object } from "../../consumer/contract/shape.js";
import { recordDigest } from "../../release/discussion/envelope.js";

export const PIPELINE_WORKER = "buildchain.pipeline-worker/v1";

export function validatePipelineWorker(binding, current, warrant) {
  object(binding, [
    "schema",
    "repository",
    "attempt",
    "generation",
    "sourceHead",
    "candidateId",
    "fencingToken",
    "leaseGeneration",
    "runId",
    "runAttempt",
    "nativeJobId",
    "sealJobId",
  ]);
  if (
    binding.schema !== PIPELINE_WORKER ||
    binding.repository !== current.intent.repository ||
    binding.attempt !== current.identity.id ||
    binding.generation !== current.generation.id ||
    binding.sourceHead !== current.generation.source.commit ||
    binding.candidateId !== warrant.candidateId ||
    binding.fencingToken !== warrant.fencingToken ||
    binding.leaseGeneration !== warrant.generation
  )
    throw new Error("Native worker does not bind the active pipeline Warrant");
  for (const key of [
    "runId",
    "runAttempt",
    "nativeJobId",
    "sealJobId",
    "leaseGeneration",
  ])
    if (!Number.isSafeInteger(binding[key]) || binding[key] < 1)
      throw new Error("Native worker provider identity is invalid");
  if (binding.nativeJobId === binding.sealJobId)
    throw new Error("Native execution and evidence seal must be separate jobs");
  return binding;
}

export function githubPipelineWorker(request) {
  async function jobs(base, binding) {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const response = await request(
        `${base}/actions/runs/${binding.runId}/attempts/${binding.runAttempt}/jobs?per_page=100&page=${page}`,
      );
      if (!Array.isArray(response.jobs))
        throw new Error("Missing provider jobs readback");
      result.push(...response.jobs);
      if (response.jobs.length < 100) return result;
    }
    throw new Error("Pipeline worker jobs exceed the readback bound");
  }
  async function observe(binding, current, warrant) {
    validatePipelineWorker(binding, current, warrant);
    const base = `/repos/${binding.repository}`;
    const run = await request(`${base}/actions/runs/${binding.runId}`);
    if (
      run.id !== binding.runId ||
      run.run_attempt !== binding.runAttempt ||
      run.repository?.full_name !== binding.repository
    )
      throw new Error(
        "Native worker provider run changed; terminality is unproved",
      );
    const entries = await jobs(base, binding);
    const selected = [binding.nativeJobId, binding.sealJobId].map((id) => {
      const matches = entries.filter((job) => job.id === id);
      if (
        matches.length !== 1 ||
        matches[0].run_id !== binding.runId ||
        matches[0].run_attempt !== binding.runAttempt
      )
        throw new Error("Native worker exact job identity drift");
      return matches[0];
    });
    const again = await request(`${base}/actions/runs/${binding.runId}`);
    if (
      again.id !== run.id ||
      again.run_attempt !== run.run_attempt ||
      again.status !== run.status ||
      again.conclusion !== run.conclusion
    )
      throw new Error("Native worker changed during terminal readback");
    const terminal =
      run.status === "completed" &&
      Boolean(run.conclusion) &&
      selected.every(
        (job) =>
          job.status === "completed" && job.conclusion && job.completed_at,
      );
    const body = {
      schema: "buildchain.pipeline-worker-readback/v1",
      binding,
      status: terminal ? "completed" : "in_progress",
      run,
      jobs: selected,
    };
    return { ...body, root: recordDigest(body) };
  }
  return { observe };
}
