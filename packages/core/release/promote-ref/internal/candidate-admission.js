import fs from "node:fs";
import { validateReleaseCandidatePassport } from "../../release-candidate.js";
import { validateReleaseCandidateRecoveryReceipt } from "../../release-candidate-recovery.js";
import { resolveMaybeRelative } from "./npm-distribution.js";
export function splitPathList(value = "") {
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
export function releaseCandidateEvidenceChannel(publicationChannel) {
  return publicationChannel === "major" ? "release" : publicationChannel;
}
export function validatePromotionReleaseCandidate({
  cwd,
  passportPath = ".buildchain/artifacts/release-candidate-passport.json",
  buildSummaryPath = ".buildchain/artifacts/build-summary.json",
  repository,
  targetChannel,
  targetRef = "",
  version = "",
  recoveryReceiptPath = "",
  sourceHeadSha,
  sourceTreeSha = "",
  requirePlatforms = true,
  requireFamilyEvidence = false,
  familyEvidenceRoot = "",
  familyInitiativeId = "",
  familyAssignmentId = "",
}) {
  const resolvedPassportPath = resolveMaybeRelative(cwd, passportPath);
  if (!fs.existsSync(resolvedPassportPath)) {
    throw new Error(
      `promote-only release candidate requires a verified RC passport at ${passportPath}; run the channel PR reusable build first and pass its release-candidate-passport artifact`,
    );
  }
  const passport = JSON.parse(fs.readFileSync(resolvedPassportPath, "utf8"));
  const resolvedSummaryPath = resolveMaybeRelative(cwd, buildSummaryPath);
  const buildSummary = fs.existsSync(resolvedSummaryPath)
    ? JSON.parse(fs.readFileSync(resolvedSummaryPath, "utf8"))
    : undefined;
  const validation = validateReleaseCandidatePassport({
    passport,
    repository,
    targetChannel: releaseCandidateEvidenceChannel(targetChannel),
    version: recoveryReceiptPath ? "" : version,
    buildSummary,
    requirePlatforms,
    requireFamilyEvidence,
    familyEvidenceRoot,
    familyInitiativeId,
    familyAssignmentId,
  });
  let recoveryReceiptValidation;
  if (recoveryReceiptPath) {
    const resolvedRecoveryReceiptPath = resolveMaybeRelative(
      cwd,
      recoveryReceiptPath,
    );
    if (!fs.existsSync(resolvedRecoveryReceiptPath)) {
      validation.errors.push(
        `recovery receipt is missing: ${recoveryReceiptPath}`,
      );
    } else {
      const recoveryReceipt = JSON.parse(
        fs.readFileSync(resolvedRecoveryReceiptPath, "utf8"),
      );
      recoveryReceiptValidation = validateReleaseCandidateRecoveryReceipt({
        receipt: recoveryReceipt,
        passport,
        repository,
        targetChannel: releaseCandidateEvidenceChannel(targetChannel),
        targetRef,
        targetSha: sourceHeadSha,
        targetTree: sourceTreeSha,
        version,
      });
      validation.errors.push(
        ...recoveryReceiptValidation.errors.map(
          (error) => `recovery receipt: ${error}`,
        ),
      );
    }
  }
  const acceptedSourceShas = [
    passport.source?.headSha,
    passport.source?.mergeRefSha,
  ].filter(Boolean);
  const sourceTreeHash = passport.source?.treeHash || "";
  if (
    sourceHeadSha &&
    !acceptedSourceShas.includes(sourceHeadSha) &&
    (!sourceTreeSha || sourceTreeHash !== sourceTreeSha)
  ) {
    validation.errors.push(
      `source identity mismatch: target SHA ${sourceHeadSha} did not match RC head/merge SHAs (${acceptedSourceShas.join(", ") || "<none>"}) or target tree ${sourceTreeSha || "<empty>"} did not match RC tree ${sourceTreeHash || "<empty>"}`,
    );
  }
  if (validation.errors.length > 0) {
    throw new Error(
      `release candidate passport validation failed: ${validation.errors.join("; ")}`,
    );
  }
  return candidateAdmissionResult({
    passport,
    sourceHeadSha,
    sourceTreeSha,
    sourceTreeHash,
    recoveryReceiptValidation,
    resolvedPassportPath,
    resolvedSummaryPath,
    buildSummary,
  });
}

function candidateAdmissionResult({
  passport,
  sourceHeadSha,
  sourceTreeSha,
  sourceTreeHash,
  recoveryReceiptValidation,
  resolvedPassportPath,
  resolvedSummaryPath,
  buildSummary,
}) {
  return {
    passportPath: resolvedPassportPath,
    buildSummaryPath: buildSummary ? resolvedSummaryPath : "",
    candidateHash: passport.candidateHash || "",
    platformCount: Array.isArray(passport.platformMatrix)
      ? passport.platformMatrix.length
      : 0,
    gateProfileEvidence: passport.gateProfileEvidence,
    familyEvidence: passport.familyEvidence,
    controllerReceipts: passport.controllerReceipts || [],
    builtSourceSha:
      passport.source?.mergeRefSha || passport.source?.headSha || "",
    builtSourceTreeSha: passport.source?.treeHash || "",
    promotionChannelSha: sourceHeadSha || "",
    promotionChannelTreeSha: sourceTreeSha || "",
    treeEquivalent: Boolean(
      sourceTreeSha && sourceTreeHash && sourceTreeSha === sourceTreeHash,
    ),
    recoveredCandidate: recoveryReceiptValidation?.ok === true,
    publicationVersionBinding: recoveryReceiptValidation?.ok
      ? "recovery-receipt"
      : "candidate-passport",
  };
}
