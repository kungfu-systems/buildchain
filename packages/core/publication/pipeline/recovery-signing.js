import path from "node:path";
import { uniquePublicationMaterial } from "./context.js";
import { requalifySealedPublication } from "./recovery-qualification.js";
import { preparePipelineSigning } from "./signing.js";

async function originalMaterial(journal, prefix, accepts) {
  const matches = (await journal.materials(prefix)).filter(accepts);
  if (matches.length !== 1)
    throw new Error(
      `Signing recovery has no unique original material: ${prefix}`,
    );
  return matches[0];
}

export async function prepareRecoveredSigning(
  context,
  host,
  journal,
  archive,
  directory,
) {
  const prepared = await uniquePublicationMaterial(
    journal,
    "publication/predecessor-prepared/",
  );
  const originalPlan = await originalMaterial(
    journal,
    "publication/predecessor-plan/",
    (plan) => plan.root === prepared.qualified.planRoot,
  );
  const originalMaterialization = await originalMaterial(
    journal,
    "publication/predecessor-materialization/",
    (value) =>
      value.planRoot === originalPlan.root &&
      value.source.commit === prepared.qualified.source.commit,
  );
  const result = await requalifySealedPublication({
    context,
    prepared,
    originalPlan,
    originalMaterialization,
    archive,
    host,
    directory,
  });
  await journal.fence();
  await journal.record(
    `publication/qualification-prepared/${context.runId}-${context.runAttempt}`,
    result,
  );
  return preparePipelineSigning({
    plan: context.plan,
    materialization: context.materialization,
    qualified: result.qualified,
    directory: path.join(directory, "signing"),
  });
}
