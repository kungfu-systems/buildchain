import path from "node:path";
import { buildPublicationArtifactCandidate } from "../candidate/artifact.js";
export function collectPaperAdmissionEvidence({
  evidenceRoot,
  repository,
  sourceSha,
  sourceTreeSha,
  runtimeSha,
}) {
  const bundle = buildPublicationArtifactCandidate({
    artifactRoot: path.join(evidenceRoot, "artifact"),
    controllerRoot: path.join(evidenceRoot, "controller"),
    repository,
    sourceSha,
    sourceTreeSha,
    runtimeSha,
  });
  return {
    controllerReceipt: bundle.evidence.controllerReceipt,
    runtimeSha,
    artifactDigest: bundle.candidate.candidateDigest,
    candidate: bundle.candidate,
  };
}
