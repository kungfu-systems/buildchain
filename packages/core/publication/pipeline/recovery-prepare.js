import { recordDigest } from "../../release/discussion/envelope.js";
import { retainedRecoveryEvidence } from "../../workflow/pipeline/recovery-session.js";
import { recoveryPublicationMaterial } from "./recovery-materials.js";

import { importRecoveredPublication } from "./recovery-import.js";

export async function prepareRecoveredPublication(
  session,
  publisherSha,
  host,
  journal,
  phase,
) {
  if (
    !session.observed.history.at(-1).identity.requestKey.startsWith("recover:")
  )
    return null;
  const { plan: recoveryPlan, evidence } = await retainedRecoveryEvidence(
    session,
    host,
  );
  const publication = evidence.publication;
  if (!publication || publication.mode === "unprepared") return null;
  const plan = recoveryPublicationMaterial(
    publication.materials,
    "publication/plan/",
    true,
  );
  if (recordDigest(host.runtime) !== recordDigest(recoveryPlan.runtime))
    throw new Error(
      "Recovered publication executor differs from the admitted repair",
    );
  const runtime = await host.request(
    `/repos/${host.runtime.repository}/git/commits/${host.runtime.sha}`,
  );
  if (
    runtime.sha !== host.runtime.sha ||
    !/^[0-9a-f]{40}$/u.test(runtime.tree?.sha || "")
  )
    throw new Error("Recovery publisher runtime has no exact admitted tree");
  const execution = {
    attempt: session.observed.attempt,
    runId: host.runId,
    runAttempt: host.runAttempt,
    publisher: {
      repository: "kungfu-systems/buildchain",
      workflow: ".github/workflows/.release-pipeline-products.yml",
      workflowSha: publisherSha,
      job: "apply",
    },
    runtime: {
      repository: host.runtime.repository,
      commit: runtime.sha,
      tree: runtime.tree.sha,
    },
  };
  const qualified = await journal.materials("publication/qualified/");
  if (qualified.length > 1)
    throw new Error("Recovered publication has conflicting qualifications");
  if (qualified.length) {
    const plans = await journal.materials("publication/plan/");
    if (plans.length !== 1 || plans[0].root !== qualified[0].qualified.planRoot)
      throw new Error("Recovered qualification lacks its one retained plan");
  }
  // A prepared recovery may already have signed and published its derived
  // plan. Later workers retain that plan even when the floating entry moves.
  if (!qualified.length)
    await importRecoveredPublication(
      publication,
      execution,
      recoveryPlan.root,
      journal,
      phase,
    );
  const mode = qualified.length ? "qualified" : publication.mode;
  return {
    planRoot: recoveryPlan.root,
    predecessor: recoveryPlan.predecessor,
    originalPlanRoot: plan.root,
    mode,
    build: publication.build || null,
    preserveTransaction: mode === "qualified",
    execution,
  };
}
