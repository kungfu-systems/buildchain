import fs from "node:fs";
import path from "node:path";
import {
  prepareGitHubArtifactAttestation,
  createGitHubArtifactAttestationEvidence,
} from "../github-artifact-attestation.js";
import { verifyArtifactAttestationSigner } from "../../providers/github/artifact-attestation.js";
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
export function prepareAttestation(request) {
  const preparation = prepareGitHubArtifactAttestation(request);
  const predicatePath = path.join(request.outputDir, "predicate.json"),
    preparationPath = path.join(request.outputDir, "preparation.json");
  write(predicatePath, preparation.predicate);
  write(preparationPath, preparation);
  return {
    "subject-name": preparation.policy.subject.name,
    "subject-path": preparation.subjectPath,
    "subject-digest": preparation.policy.subject.digest,
    "predicate-type": preparation.predicateType,
    "predicate-path": predicatePath,
    "preparation-path": preparationPath,
    "preparation-json": JSON.stringify(preparation),
  };
}
export function sealAttestation(
  {
    outputDir,
    preparation,
    bundlePath,
    attestationId,
    attestationUrl,
    workflow,
    runtimeSha,
    sourceSha,
    token,
    environment,
  },
  verify = verifyArtifactAttestationSigner,
) {
  if (
    preparation.policy.signer.workflowDigest !== runtimeSha ||
    preparation.policy.caller.sourceSha !== sourceSha ||
    preparation.policy.caller.repository !== workflow.repository
  )
    throw new Error(
      "Attestation preparation differs from the admitted signer or caller",
    );
  fs.mkdirSync(outputDir, { recursive: true });
  verify({
    subjectPath: preparation.subjectPath,
    repository: workflow.repository,
    runtimeSha,
    sourceSha,
    predicateType: preparation.predicateType,
    bundlePath,
    token,
    environment,
    outputPath: path.join(outputDir, "provider-verification.json"),
  });
  const stagedBundlePath = path.join(outputDir, "sigstore-bundle.json");
  fs.copyFileSync(bundlePath, stagedBundlePath);
  const evidence = createGitHubArtifactAttestationEvidence({
    preparation,
    attestationId,
    attestationUrl,
    bundlePath: stagedBundlePath,
    workflow,
  });
  const evidencePath = path.join(
    outputDir,
    "github-artifact-attestation-evidence.json",
  );
  write(evidencePath, evidence);
  return {
    "evidence-path": evidencePath,
    "evidence-root": evidence.evidenceRoot,
    "bundle-digest": evidence.attestation.bundle.digest,
    "bundle-path": stagedBundlePath,
  };
}
