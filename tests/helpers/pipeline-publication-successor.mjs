import { inspectRecoveryPublication } from "../../packages/core/publication/pipeline/recovery-inspection.js";
import { planPipelineRecovery } from "../../packages/core/workflow/pipeline/recovery-plan.js";
import { openRecoveryAttempt } from "../../packages/core/workflow/pipeline/recovery-session.js";
import { preparePipelinePublication } from "../../packages/core/publication/pipeline/prepare.js";
import { publicationContext } from "../../packages/core/publication/pipeline/context.js";
import { recordDigest } from "../../packages/core/release/discussion/envelope.js";

export async function publicationSuccessor(f, current, runId) {
  current.observed = await current.journal.read();
  await current.progress.progress({
    attempt: current.observed.attempt,
    phase: current.observed.missing[0],
    state: "cancelled",
    eventKey: `interrupted:${runId}`,
  });
  current.observed = await current.journal.read();
  f.complete.add(f.host.runId);
  f.host.runId = runId;
  f.host.writer = { ...f.host.writer, runId: String(runId) };
  f.host.runtime = { ...f.host.runtime, sha: "9".repeat(40) };
  Object.assign(f.f.admission.live, {
    state: "closed",
    merged: true,
    mergeCommit: f.merge.commit,
  });
  const integration = {
    mergeCommit: f.merge.commit,
    mergeTree: f.merge.tree,
    build: { root: recordDigest("protected-checks") },
    root: recordDigest("integration"),
  };
  f.host.integration.observe = async () => integration;
  f.host.policy.observeMerged = async () => ({
    review: true,
    checksPassing: true,
    root: recordDigest(integration),
  });
  const admitted = { admission: f.f.admission };
  const publication = await inspectRecoveryPublication(
    current,
    admitted,
    f.host,
    { verifySigning: f.verifySigning },
  );
  const evidence = { publication };
  const plan = planPipelineRecovery({
    observed: current.observed,
    runtime: f.host.runtime,
    entry: {
      repository: "kungfu-systems/buildchain",
      workflow: ".github/workflows/public-ops-recover.yml",
      sha: f.publisher,
    },
    evidenceRoot: recordDigest(evidence),
    nodes: current.intent.expectedNodes.map((phase) => ({
      phase,
      operation: "reconcile",
      reason: "Publication adapter recovery fixture",
      evidenceRoots: [],
    })),
  });
  const successor = await openRecoveryAttempt(current, plan, f.host, evidence);
  for (const phase of ["admission", "build", "review", "merge"])
    await successor.progress.progress({
      attempt: successor.observed.attempt,
      phase,
      state: "success",
      eventKey: `qualified:${phase}`,
    });
  const prepared = await preparePipelinePublication(
    successor.observed.attempt,
    f.publisher,
    f.host,
  );
  const loaded = await publicationContext(prepared.context, f.host);
  return {
    ...loaded,
    context: prepared.context,
    operation: prepared.operation,
  };
}
