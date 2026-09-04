import fs from "node:fs";
import path from "node:path";

const read = (file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

function standardCandidatePath(
  candidatePassportPath,
  declaredPath,
  relativePath,
  label,
) {
  if (String(declaredPath || "").trim()) return declaredPath;
  const fallback = path.join(
    path.dirname(candidatePassportPath),
    "..",
    relativePath,
  );
  if (!fs.existsSync(path.resolve(fallback)))
    throw new Error(
      `${label} is required when the sealed candidate has no standard ${relativePath}`,
    );
  return fallback;
}

export function resolveCandidateProviderInputs({
  candidatePassportPath,
  artifactKind = "npm",
  sealedBundleRoot = "",
  sealedBundleManifest = "",
  requiredArtifactsPath = "",
  publishPackageMain = "",
}) {
  const normalizedArtifactKind = String(artifactKind || "npm").trim();
  const resolved = {
    sealedBundleRoot:
      normalizedArtifactKind === "npm"
        ? standardCandidatePath(
            candidatePassportPath,
            sealedBundleRoot,
            "payloads",
            "sealed-bundle-root",
          )
        : "",
    sealedBundleManifest:
      normalizedArtifactKind === "npm"
        ? standardCandidatePath(
            candidatePassportPath,
            sealedBundleManifest,
            "sealed-bundle.json",
            "sealed-bundle-manifest",
          )
        : "",
    requiredArtifactsPath: standardCandidatePath(
      candidatePassportPath,
      requiredArtifactsPath,
      "publish-required-artifacts.json",
      "required-artifacts-path",
    ),
    publishPackageMain: String(publishPackageMain || "").trim(),
  };
  if (resolved.sealedBundleManifest) {
    const recoveryReceiptPath = path.join(
      path.dirname(resolved.sealedBundleManifest),
      "recovery-receipt.json",
    );
    if (fs.existsSync(path.resolve(recoveryReceiptPath)))
      resolved.releaseCandidateRecoveryReceiptPath = recoveryReceiptPath;
  }
  if (normalizedArtifactKind === "npm" && !resolved.publishPackageMain) {
    const artifacts = read(resolved.requiredArtifactsPath);
    const main = artifacts.filter(({ role }) => role === "main");
    const requiredNpm = artifacts.filter(
      ({ kind, required }) => kind === "npm" && required !== false,
    );
    const inferred =
      main.length === 1 && String(main[0]?.name || "").trim()
        ? main[0]
        : requiredNpm.length === 1 && String(requiredNpm[0]?.name || "").trim()
          ? requiredNpm[0]
          : null;
    if (!inferred)
      throw new Error(
        "publish-package-main is required when the sealed artifact set has no unique main package",
      );
    resolved.publishPackageMain = String(inferred.name).trim();
  }
  return resolved;
}
