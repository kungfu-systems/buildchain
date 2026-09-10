import fs from "node:fs";
import path from "node:path";
import { verifyPublicationAdmission } from "../publication-authority.js";
import { verifyCheckoutIdentity } from "../../runtime/checkout-identity.js";
import { readGitHubSourceTree } from "../../providers/github/commits.js";
import { publicationVerificationEvidence } from "./verification-evidence.js";
export async function verifySealedAdmission(
  {
    request,
    workspace,
    runtimeRoot,
    token,
    apiUrl,
    admission,
    runnerProvenance,
    controlPlaneAudit,
    gateAggregate,
    expected,
    usedNonces,
  },
  { tree = readGitHubSourceTree, verifyCheckout = verifyCheckoutIdentity } = {},
) {
  verifyCheckout({
    directory: runtimeRoot,
    sha: request.buildchainRef,
    label: "Authority runtime",
  });
  const sourceTreeSha = await tree({
    repository: admission.repository,
    sourceSha: admission.sourceSha,
    token,
    apiUrl,
  });
  const publicationEvidence = publicationVerificationEvidence({
    kind: request.autoAdmissionKind,
    evidenceRoot: path.join(workspace, ".buildchain/publication-evidence"),
    sourceTreeSha,
    runtimeSha: request.buildchainRef,
    admission,
    gateAggregate,
  });
  const capability = verifyPublicationAdmission({
    admission,
    registry: JSON.parse(
      fs.readFileSync(
        path.join(runtimeRoot, "dist/site/publication-authority-registry.json"),
        "utf8",
      ),
    ),
    runnerProvenance,
    controlPlaneAudit,
    publicationEvidence,
    expected,
    usedNonces,
  });
  validateCapabilityBinding(capability, request, request.buildchainRef);
  return { capability, gateAggregate: publicationEvidence.gateAggregate };
}
export function validateCapabilityBinding(
  capability,
  request,
  actualRuntimeSha,
) {
  if (
    request.autoAdmissionKind !== "binary-release-assets" &&
    capability.runtimeSha !== actualRuntimeSha
  ) {
    throw new Error(
      `authority runtime checkout mismatch: expected ${capability.runtimeSha}, got ${actualRuntimeSha}`,
    );
  }
  if (capability.version !== request.publicationVersion) {
    throw new Error(
      `authority publication version mismatch: planned ${request.publicationVersion || "<empty>"}, capability ${capability.version || "<empty>"}`,
    );
  }
  const qualificationRequired = request.consumerQualificationRequired === true;
  if (typeof capability.qualification?.required !== "boolean")
    throw new Error(
      "authority capability must declare its qualification requirement",
    );
  const capabilityQualificationRequired = capability.qualification.required;
  if (capabilityQualificationRequired !== qualificationRequired) {
    throw new Error("authority consumer qualification requirement mismatch");
  }
  if (
    qualificationRequired &&
    (capability.qualification.predicateId !== request.consumerPredicateId ||
      capability.qualification.predicateDigest !==
        request.consumerPredicateDigest)
  ) {
    throw new Error("authority consumer predicate binding mismatch");
  }
}
