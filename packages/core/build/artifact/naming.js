export const DEFAULT_ARTIFACT_NAME_TEMPLATE = "{artifact}-{platform}-{sha}";

export function sanitizeArtifactName(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|\r\n]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolveArtifactContract({
  artifactName = "buildchain-artifact",
  artifactNameTemplate = DEFAULT_ARTIFACT_NAME_TEMPLATE,
  platformId = "",
  platformName = "",
  sha = "",
  ref = "",
  runId = "",
  runAttempt = "",
} = {}) {
  const baseName =
    String(artifactName || "buildchain-artifact").trim() ||
    "buildchain-artifact";
  const template =
    String(artifactNameTemplate || "").trim() || DEFAULT_ARTIFACT_NAME_TEMPLATE;
  const replacements = {
    artifact: baseName,
    artifactName: baseName,
    platform: platformId,
    platformId,
    platformName,
    sha,
    shortSha: sha ? sha.slice(0, 12) : "",
    ref,
    runId,
    runAttempt,
  };
  const resolved = template.replace(
    /\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (match, key) => {
      if (!Object.hasOwn(replacements, key)) {
        throw new Error(
          `unsupported artifact-name-template placeholder: ${match}`,
        );
      }
      return replacements[key] || "";
    },
  );
  const safeName = sanitizeArtifactName(resolved);
  if (!safeName) {
    throw new Error(
      "artifact-name-template resolved to an empty artifact name",
    );
  }
  return {
    artifactName: safeName,
    artifactBaseName: baseName,
    artifactNameTemplate: template,
    platform: {
      id: platformId,
      name: platformName || platformId,
    },
  };
}
