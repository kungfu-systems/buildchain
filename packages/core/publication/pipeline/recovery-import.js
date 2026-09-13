import { recordDigest } from "../../release/discussion/envelope.js";
import { recoveryPublicationMaterial } from "./recovery-materials.js";
import { deriveRecoveryPublicationPlan } from "./recovery-plan.js";
import {
  PUBLICATION_IMPORT,
  publicationImportedValues,
} from "./imported-materials.js";

function importedId(item, publication) {
  const id = item.id;
  if (id.startsWith("publication/worker/")) return null;
  if (id.startsWith("publication/context/"))
    return "publication/predecessor-context";
  if (
    id.startsWith("publication/qualification-prepared/") ||
    id.startsWith("publication/predecessor-prepared/")
  )
    return publication.mode !== "qualified" &&
      recordDigest(item.value) === publication.preparedRoot
      ? "publication/predecessor-prepared"
      : null;
  for (const name of [
    "complete",
    "distribution-complete",
    "next-development-result",
  ])
    if (id.startsWith(`publication/${name}/`))
      return `publication/predecessor-${name}`;
  if (publication.mode !== "qualified")
    for (const name of ["plan", "materialization"])
      if (id.startsWith(`publication/${name}/`))
        return `publication/predecessor-${name}`;
  return id.slice(0, id.lastIndexOf("/"));
}

export async function importRecoveredPublication(
  publication,
  execution,
  recoveryPlanRoot,
  journal,
  phase,
) {
  const values = [];
  const add = (id, value) =>
    values.push({ id: `${id}/${recordDigest(value).slice(7)}`, value });
  for (const item of publication.materials) {
    const id = importedId(item, publication);
    if (id) add(id, item.value);
  }
  if (publication.mode !== "qualified") {
    const original = recoveryPublicationMaterial(
      publication.materials,
      "publication/plan/",
      true,
    );
    const materialization = recoveryPublicationMaterial(
      publication.materials,
      "publication/materialization/",
    );
    const derived = deriveRecoveryPublicationPlan(
      original,
      materialization,
      execution,
      recoveryPlanRoot,
    );
    add("publication/plan", derived.plan);
    if (derived.materialization)
      add("publication/materialization", derived.materialization);
  }
  const body = {
    schema: PUBLICATION_IMPORT,
    admissionRoot: recoveryPlanRoot,
    values: [...new Map(values.map((item) => [item.id, item])).values()],
  };
  const bundle = { ...body, root: recordDigest(body) };
  publicationImportedValues(bundle);
  // One journal append publishes the complete import and derived source/plan.
  // An interruption cannot expose a new plan beside an old materialization.
  await journal.record("publication/recovery-import", bundle, { phase });
}
