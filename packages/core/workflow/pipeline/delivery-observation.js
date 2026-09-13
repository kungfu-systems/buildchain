import { GitHubDevDeliveryStore } from "../../providers/dev-delivery/store.js";
import { defaultDevDeliveryStateRef } from "../../dev-delivery/warrant/values.js";
import { createDeliveryWarrantService } from "../../dev-delivery/warrant/service.js";
import { PIPELINE_WORKER } from "../../providers/github/pipeline-worker.js";
import { pipelineCandidate } from "./reconcile.js";

function workerJob(jobs, name) {
  const selected = jobs.filter(
    (job) => job.name === name || job.name.endsWith(` / ${name}`),
  );
  if (selected.length > 1)
    throw new Error("Native worker job identity is ambiguous");
  return selected[0];
}

export async function observePipelineWorker(session, current, queue, host) {
  const warrant = queue.activeWarrant;
  const candidate = pipelineCandidate(queue, current);
  if (
    !warrant ||
    candidate?.candidateId !== warrant.candidateId ||
    warrant.sourceHead !== current.generation.source.commit ||
    warrant.pullRequestNumber !== current.intent.source.pullRequest
  )
    return null;
  const phase = [...current.events]
    .reverse()
    .find((event) =>
      event.payload.materials.some((material) =>
        material.id.startsWith("delivery/execution-"),
      ),
    );
  const references =
    phase?.payload.materials.filter((material) =>
      material.id.startsWith("delivery/execution-"),
    ) || [];
  if (!references.length) return null;
  if (references.length !== 1)
    throw new Error("Native worker requires one admitted execution");
  const execution = await host.materialStore(session).read(references[0]);
  if (
    execution.attempt !== current.identity.id ||
    execution.generation !== current.generation.id
  )
    throw new Error("Native worker execution belongs to another attempt");
  const { run, jobs } = await host.runs.read(
    execution.runId,
    execution.runAttempt,
  );
  if (run.status !== "completed") {
    const terminalJobs = [
      "Credentialless native execution",
      "Credentialless native evidence seal",
    ].map((name) => workerJob(jobs, name));
    if (terminalJobs.some((job) => !job || job.status !== "completed"))
      return {
        status: "in_progress",
        reason: "admitted-execution-not-terminal",
        run,
      };
  }
  const entries = (run.referenced_workflows || []).filter((entry) =>
    entry.path?.startsWith(
      "kungfu-systems/buildchain/.github/workflows/public-ops-dev-auto-merge.yml@",
    ),
  );
  if (entries.length !== 1) return null;
  const native = workerJob(jobs, "Credentialless native execution"),
    seal = workerJob(jobs, "Credentialless native evidence seal");
  if (!native || !seal) return null;
  if (
    run.status !== "completed" &&
    run.id !== host.runId &&
    native.status === "completed" &&
    seal.status === "completed"
  )
    await host.runs.completed(execution.runId, execution.runAttempt);
  return host.workers.observe(
    {
      schema: PIPELINE_WORKER,
      repository: host.repository,
      attempt: current.identity.id,
      generation: current.generation.id,
      sourceHead: warrant.sourceHead,
      candidateId: warrant.candidateId,
      fencingToken: warrant.fencingToken,
      leaseGeneration: warrant.generation,
      runId: execution.runId,
      runAttempt: execution.runAttempt,
      nativeJobId: native.id,
      sealJobId: seal.id,
    },
    current,
    warrant,
  );
}

export function pipelineDeliveryStore(session, host) {
  const branch = session.intent.source.targetBranch;
  const store = new GitHubDevDeliveryStore({
    repository: host.repository,
    token: host.token,
  });
  return {
    read: async () =>
      (
        await store.read({
          stateRef: defaultDevDeliveryStateRef(branch),
          protectedBase: branch,
          now: new Date().toISOString(),
        })
      ).queue,
    service: createDeliveryWarrantService(
      { repository: host.repository, token: host.token, branch },
      store,
    ),
  };
}
