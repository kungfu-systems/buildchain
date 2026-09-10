import { verifySourceQualificationProof } from "../dev-delivery-proof.js";
export function resolveCandidateAffectedPaths({
  affectedPaths,
  sourceProofRoot,
  source,
  readProof,
}) {
  if (!Array.isArray(affectedPaths))
    throw new Error("Affected paths must be an array");
  if (affectedPaths.length) return affectedPaths;
  const proof = readProof();
  if (proof.proofRoot !== sourceProofRoot)
    throw new Error(
      "Affected path proof does not match the admitted source proof root",
    );
  const verification = verifySourceQualificationProof(proof, source);
  if (!verification.ok)
    throw new Error(`Affected path proof failed: ${verification.reason}`);
  return proof.affectedPaths;
}
