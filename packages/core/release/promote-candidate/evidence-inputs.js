import { read } from "./files.js";
import { validateReleaseCandidateRecoveryReceipt } from "../release-candidate-recovery.js";

function required(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required`);
  return value.trim();
}

export function resolveCandidateBuildSummaryPath({ declaredPath }) {
  return required(declaredPath, "candidate-build-summary-path");
}

export function resolveCandidateProviderInputs({
  artifactKind = "npm",
  sealedBundleRoot,
  sealedBundleManifest,
  requiredArtifactsPath,
  publishPackageMain = "",
  recoveryReceiptPath = "",
}) {
  if (!["npm", "oci", "custom"].includes(artifactKind))
    throw new Error("Unsupported publication artifact kind");
  const bundle = artifactKind !== "custom";
  const resolved = {
    sealedBundleRoot: bundle
      ? required(sealedBundleRoot, "sealed-bundle-root")
      : "",
    sealedBundleManifest: bundle
      ? required(sealedBundleManifest, "sealed-bundle-manifest")
      : "",
    requiredArtifactsPath: required(
      requiredArtifactsPath,
      "required-artifacts-path",
    ),
    publishPackageMain: publishPackageMain.trim(),
    releaseCandidateRecoveryReceiptPath: recoveryReceiptPath.trim(),
  };
  if (artifactKind === "npm" && !resolved.publishPackageMain) {
    const artifacts = read(resolved.requiredArtifactsPath);
    const main = artifacts.filter(({ role }) => role === "main");
    const requiredPackages = artifacts.filter(
      ({ kind, required }) => kind === "npm" && required !== false,
    );
    const selected =
      main.length === 1
        ? main[0]
        : main.length === 0 && requiredPackages.length === 1
          ? requiredPackages[0]
          : null;
    resolved.publishPackageMain = required(
      selected?.name,
      "Unique main package in the sealed artifact set or publish-package-main",
    );
  }
  return resolved;
}

export function resolvePublicationTarget({
  candidate,
  repository,
  channel,
  sourceSha,
  targetRef,
  targetSha,
  recoveryReceiptPath = "",
  expectedTransactionId = "",
}) {
  const ref = required(targetRef, "target-ref"),
    sha = required(targetSha, "target-sha");
  if (!/^[0-9a-f]{40}$/u.test(sha) || sourceSha !== sha)
    throw new Error(
      "source-sha must bind the exact protected target-sha, including candidate recovery",
    );
  if (expectedTransactionId && !recoveryReceiptPath)
    throw new Error("resume-transaction-id requires recovery-receipt-path");
  if (recoveryReceiptPath) {
    const receipt = read(recoveryReceiptPath);
    const validation = validateReleaseCandidateRecoveryReceipt({
      receipt,
      passport: candidate,
      repository,
      targetChannel: channel,
      targetRef: ref,
      targetSha: sha,
      targetTree: candidate.source?.treeHash,
    });
    if (!validation.ok)
      throw new Error(
        `Recovery receipt is invalid: ${validation.errors.join("; ")}`,
      );
    if (
      expectedTransactionId &&
      receipt.transaction?.identity !== expectedTransactionId
    )
      throw new Error("Recovery receipt transaction identity mismatch");
  }
  return { sourceSha: sha, targetRef: ref, targetSha: sha };
}
