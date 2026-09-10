import { createPublicationGateDecision } from "../publication-authority.js";
export function admissionGateDecision(request) {
  const kind = request.autoAdmissionKind;
  if (kind !== "publication-artifact" && request.gateAggregate)
    return request.gateAggregate;
  if (kind !== "publication-artifact" && request.autoNoGate !== true)
    throw new Error(
      "Publication admission requires a Gate aggregate or explicit no-Gate decision",
    );
  const policies = {
    "release-candidate": {
      profile: "managed-release-candidate-no-gate",
      scope: "managed-release-candidate",
      rationale:
        "The consumer explicitly declared no Shifu Gate registry for this publication transaction.",
    },
    "publication-artifact": {
      profile: "managed-paper-publication",
      scope: "managed-paper-publication",
      rationale:
        "The managed paper repository declares no project-specific Shifu Gate registry.",
    },
    "binary-release-assets": {
      profile: "buildchain-binary-release-no-gate",
      scope: "binary-release-assets",
      rationale:
        "Buildchain standalone release assets carry provider-owned evidence and declare no consumer Shifu Gate registry.",
    },
  };
  const policy = policies[kind];
  if (!policy) throw new Error("Unknown publication admission Gate policy");
  return createPublicationGateDecision({
    sourceSha: request.sourceSha,
    profile: policy.profile,
    required: false,
    rationale: policy.rationale,
    policy: { scope: policy.scope, repository: request.evidenceRepository },
  });
}
