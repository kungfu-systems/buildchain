import { domainContentRoot } from "../contracts/canonical-contracts.js";
import { releaseTailRoot } from "../release/release-tail-provider-plane.js";
import { ociPublicationTag } from "./oci-publication-graph.js";

function check(condition, message) {
  if (!condition) throw new Error(`Compose preview: ${message}`);
}

export function verifyComposePublication({
  family,
  readback,
  documents,
  repository,
  tag,
}) {
  const { root, ...body } = family;
  const version = tag.replace(/^v/u, "");
  const operation = documents.productState.operations.find(
    (entry) => entry.capabilityId === "product.oci.publish",
  );
  check(
    family.schema === "kungfu-buildchain-oci-family/v2" &&
      root === domainContentRoot("oci-publication-family", body) &&
      family.repository === repository &&
      family.version === version &&
      family.sourceSha === documents.passport.source.builtSourceSha &&
      documents.passport.source.builtSourceTreeSha ===
        documents.invocation.candidate.tree &&
      readback.sourceSha === documents.invocation.candidate.commit &&
      readback.familyRoot === root &&
      readback.version === version &&
      readback.candidateSourceSha === family.sourceSha &&
      operation?.receipt.evidenceRoots.includes(releaseTailRoot(readback)),
    "unbound public OCI family",
  );
  const applications = family.images.filter(
    (entry) => entry.kind === "compose" && entry.preview,
  );
  check(applications.length === 1, "expected one declared Compose preview");
  const application = applications[0],
    policy = application.preview;
  check(
    policy.alias === "compose-preview" &&
      /^\.github\/workflows\/[a-z0-9-]+\.yml$/u.test(
        policy.qualificationWorkflow,
      ) &&
      /^(none|sha256:[0-9a-f]{64})$/u.test(policy.previousDigest),
    "invalid preview policy",
  );
  const image = family.images.find(
    (entry) =>
      entry.name === application.targetImage && entry.kind !== "compose",
  );
  check(
    image &&
      application.repository === image.repository &&
      image.repository === `ghcr.io/${repository}/${image.name}` &&
      /^[a-z0-9][a-z0-9._-]*$/u.test(image.name),
    "foreign application destination",
  );
  for (const entry of [image, application])
    check(
      readback.images.some(
        (observed) =>
          observed.name === entry.name &&
          observed.repository === entry.repository &&
          observed.digest === entry.digest &&
          observed.ref === ociPublicationTag(entry, version) &&
          observed.anonymous === true,
      ),
      "missing public artifact readback",
    );
  return {
    application,
    image,
    policy,
    familyRoot: root,
    repository,
    tag,
    sourceSha: documents.product.publication.releaseSha,
    publicationReceiptRoot: documents.receipt.receiptRoot,
  };
}

export function verifyComposeQualification(context, run, receipt) {
  const { application, image, policy, repository, tag, sourceSha, familyRoot } =
    context;
  check(
    run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository &&
      run.event === "workflow_dispatch" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.head_sha === sourceSha &&
      run.path.split("@")[0] === policy.qualificationWorkflow,
    "qualification run is not the exact published source",
  );
  if (!receipt) return;
  check(
    receipt.schema === "kungfu-buildchain-compose-qualification/v1" &&
      receipt.repository === repository &&
      receipt.tag === tag &&
      receipt.sourceSha === sourceSha &&
      receipt.familyRoot === familyRoot &&
      String(receipt.runId) === String(run.id) &&
      Number(receipt.runAttempt) === run.run_attempt &&
      receipt.image === `${image.repository}@${image.digest}` &&
      receipt.application ===
        `${application.repository}@${application.digest}` &&
      receipt.previousDigest === policy.previousDigest &&
      receipt.passed === true,
    "qualification receipt identity mismatch",
  );
  for (const name of [
    "freshInstall",
    "restartPersistence",
    "upgradePersistence",
    "rollbackPersistence",
    "accountIsolation",
    "hardenedRuntime",
  ])
    check(receipt.checks?.[name] === true, `qualification lacks ${name}`);
  check(
    Array.isArray(image.platforms) &&
      image.platforms.length === 2 &&
      JSON.stringify([...image.platforms].sort()) ===
        JSON.stringify(["linux/amd64", "linux/arm64"]) &&
      image.platforms.every(
        (platform) => receipt.platforms?.[platform]?.passed === true,
      ),
    "qualification lacks both platforms",
  );
  check(
    Array.isArray(receipt.evidence) &&
      receipt.evidence.length > 0 &&
      receipt.evidence.every(
        (entry) =>
          /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(entry.path) &&
          /^sha256:[0-9a-f]{64}$/u.test(entry.sha256),
      ),
    "missing qualification evidence bindings",
  );
}
