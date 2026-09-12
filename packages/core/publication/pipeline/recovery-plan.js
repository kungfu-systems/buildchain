import { recordDigest } from "../../release/discussion/envelope.js";
import { verifyPipelinePublicationPlan } from "./plan.js";
import { verifyRootedPublication } from "./documents.js";

// Before signing or publishing, a new publisher may qualify the already sealed
// bytes under an explicit derived plan. Original manifests and source stay exact.
export function deriveRecoveryPublicationPlan(
  original,
  materialization,
  execution,
  recoveryPlanRoot,
) {
  verifyPipelinePublicationPlan(original);
  const { root: previous, ...body } = original;
  const value = {
    ...body,
    attempt: execution.attempt,
    runtime: execution.runtime,
    publisher: execution.publisher,
    recovery: {
      predecessorPlanRoot: previous,
      admissionRoot: recoveryPlanRoot,
    },
  };
  const plan = { ...value, root: recordDigest(value) };
  if (!materialization) return { plan, materialization: null };
  verifyRootedPublication(
    materialization,
    "buildchain.pipeline-version-materialization/v1",
  );
  if (
    materialization.planRoot !== original.root ||
    recordDigest(materialization.protectedSource) !==
      recordDigest(original.source)
  )
    throw new Error(
      "Recovery version materialization changed its original plan",
    );
  const { root, ...source } = materialization;
  const derived = {
    ...source,
    planRoot: plan.root,
    recovery: { predecessorRoot: root, predecessorPlanRoot: previous },
  };
  return { plan, materialization: { ...derived, root: recordDigest(derived) } };
}
