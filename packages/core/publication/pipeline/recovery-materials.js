import { recordDigest } from "../../release/discussion/envelope.js";
import { retainedRecoveryEvidence } from "../../workflow/pipeline/recovery-session.js";
import {
  PUBLICATION_IMPORT,
  publicationImportedValues,
} from "./imported-materials.js";

export async function readRecoveryPublicationMaterials(session, host) {
  const current = session.observed.history.at(-1);
  const references = current.events
    .flatMap((event) => event.payload.materials)
    .filter((item) => item.id.startsWith("publication/"));
  const unique = [
    ...new Map(
      references.map((reference) => [
        `${reference.id}:${reference.digest}`,
        reference,
      ]),
    ).values(),
  ];
  if (unique.length > 1000)
    throw new Error(
      "Publication recovery material inventory exceeds its bound",
    );
  const result = [];
  for (const reference of unique) {
    const value = await host.materialStore(session).read(reference);
    if (value.schema === PUBLICATION_IMPORT)
      result.push(
        ...publicationImportedValues(value).map((item) => ({
          id: item.id,
          reference,
          memberId: item.id,
          value: item.value,
        })),
      );
    else result.push({ id: reference.id, reference, value });
  }
  if (
    !result.some((item) => item.id.startsWith("publication/plan/")) &&
    current.identity.requestKey.startsWith("recover:")
  ) {
    const { evidence } = await retainedRecoveryEvidence(session, host);
    for (const item of evidence.publication?.materials || []) {
      const producer = session.observed.history.find(
        (entry) => entry.identity.id === item.reference.producerAttempt,
      );
      if (!producer)
        throw new Error(
          "Publication recovery material has no canonical predecessor",
        );
      const retained = {
        ...session,
        observed: { ...session.observed, history: [producer] },
      };
      const container = await host.materialStore(retained).read(item.reference);
      const value = item.memberId
        ? publicationImportedValues(container).find(
            (member) => member.id === item.memberId,
          )?.value
        : container;
      if (recordDigest(value) !== recordDigest(item.value))
        throw new Error("Retained predecessor publication material changed");
      result.push({ ...item, value });
    }
  }
  if (result.length > 1000)
    throw new Error(
      "Expanded publication recovery inventory exceeds its bound",
    );
  return signedRecoveryMaterials(result);
}

function signedRecoveryMaterials(materials) {
  const plans = materials.filter((item) =>
    item.id.startsWith("publication/plan/"),
  );
  if (new Set(plans.map((item) => item.value.root)).size < 2) return materials;
  const retained = recoveryPublicationMaterial(
    materials,
    "publication/qualified/",
  );
  if (!retained?.signing) return materials;
  const plan = publicationLineageMaterial(
    materials,
    retained.qualified.schema ===
      "buildchain.pipeline-publication-qualification/v2"
      ? "buildchain.pipeline-publication-plan/v2"
      : "buildchain.pipeline-publication-plan/v1",
    (value) => value.root === retained.qualified.planRoot,
  );
  const materialization = publicationLineageMaterial(
    materials,
    "buildchain.pipeline-version-materialization/v1",
    (value) => value.root === retained.signing.materializationRoot,
  );
  const planIdentity = ({
    root,
    publisher: { workflowSha, ...publisher },
    ...body
  }) => recordDigest({ ...body, publisher });
  const sourceIdentity = ({ root, planRoot, ...body }) => recordDigest(body);
  for (const item of plans)
    if (planIdentity(item.value) !== planIdentity(plan))
      throw new Error(
        "Conflicting recovery plans changed more than the publisher entry",
      );
  // Preserve every original reference and member ID. Only a signed lineage
  // can classify the otherwise identical, unsigned rederivation as history.
  return materials.map((item) => {
    let name;
    if (
      item.id.startsWith("publication/plan/") &&
      item.value.root !== plan.root
    )
      name = "plan";
    if (
      item.id.startsWith("publication/materialization/") &&
      item.value.root !== materialization.root
    ) {
      if (sourceIdentity(item.value) !== sourceIdentity(materialization))
        throw new Error(
          "Conflicting recovery materializations changed retained source",
        );
      name = "materialization";
    }
    return name
      ? {
          ...item,
          id: item.id.replace(
            `publication/${name}/`,
            `publication/predecessor-${name}/`,
          ),
        }
      : item;
  });
}

export function recoveryPublicationMaterial(
  materials,
  prefix,
  required = false,
) {
  const values = [
    ...new Map(
      materials
        .filter((item) => item.id.startsWith(prefix))
        .map((item) => [recordDigest(item.value), item.value]),
    ).values(),
  ];
  if (values.length > 1 || (required && values.length !== 1))
    throw new Error(
      `Publication recovery needs one exact retained material: ${prefix}`,
    );
  return values[0] || null;
}

export function publicationLineageMaterial(materials, schema, accepts) {
  const values = [
    ...new Map(
      materials.map((item) => [recordDigest(item.value), item.value]),
    ).values(),
  ].filter((value) => value.schema === schema && accepts(value));
  if (values.length !== 1)
    throw new Error(
      `Publication recovery has no exact original lineage material: ${schema}`,
    );
  return values[0];
}
