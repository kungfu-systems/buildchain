import { issue } from "./issues.js";
export function validateReleaseState({ passport, issues }) {
  if (passport?.trustedPublishing) {
    if (!passport.trustedPublishing.provider) {
      issues.push(
        issue(
          "error",
          "trustedPublishing.provider",
          "trustedPublishing.provider is required",
        ),
      );
    }
    if (passport.trustedPublishing.auth !== "trusted-publishing") {
      issues.push(
        issue(
          "error",
          "trustedPublishing.auth",
          "trustedPublishing.auth must be trusted-publishing",
        ),
      );
    }
    if (passport.trustedPublishing.enabled !== true) {
      issues.push(
        issue(
          "error",
          "trustedPublishing.enabled",
          "trusted publishing evidence must be enabled",
        ),
      );
    }
  }
  if (passport?.transaction) {
    if (!passport.transaction.state) {
      issues.push(
        issue("error", "transaction.state", "transaction.state is required"),
      );
    } else if (passport.transaction.state !== "complete") {
      issues.push(
        issue(
          "error",
          "transaction.state",
          "release passport transaction state must be complete",
        ),
      );
    }
    for (const field of [
      "exactTag",
      "releaseSha",
      "releaseMaterialSha",
      "stateRef",
    ]) {
      if (!passport.transaction[field]) {
        issues.push(
          issue(
            "error",
            `transaction.${field}`,
            `transaction.${field} is required`,
          ),
        );
      }
    }
  }
  if (passport?.anchorManifest) {
    if (!passport.anchorManifest.sha256) {
      issues.push(
        issue(
          "error",
          "anchorManifest.sha256",
          "anchorManifest.sha256 is required",
        ),
      );
    }
    if (
      !passport.anchorManifest.fields ||
      typeof passport.anchorManifest.fields !== "object" ||
      Array.isArray(passport.anchorManifest.fields)
    ) {
      issues.push(
        issue(
          "error",
          "anchorManifest.fields",
          "anchorManifest.fields must be an object",
        ),
      );
    }
  }
  if (!passport?.runnerPolicy?.productionDefault) {
    issues.push(
      issue(
        "warning",
        "runnerPolicy.productionDefault",
        "runner policy should record the production default",
      ),
    );
  }
}
export function validateVersionMaterial({ passport, issues }) {
  if (!passport?.versionMaterial) {
    return;
  }
  if (
    passport.versionMaterial.contract !==
    "kungfu-buildchain-anchored-version-material/v1"
  ) {
    issues.push(
      issue(
        "error",
        "versionMaterial.contract",
        "versionMaterial contract must be kungfu-buildchain-anchored-version-material/v1",
      ),
    );
  }
  if (
    !passport.versionMaterial.alpha?.tree ||
    !passport.versionMaterial.release?.tree
  ) {
    issues.push(
      issue(
        "error",
        "versionMaterial.tree",
        "versionMaterial must record alpha and release tree identities",
      ),
    );
  }
  const allowedPaths = Array.isArray(passport.versionMaterial.allowedPaths)
    ? passport.versionMaterial.allowedPaths
    : [];
  const derivedFiles = Array.isArray(passport.versionMaterial.derivedFiles)
    ? passport.versionMaterial.derivedFiles
    : [];
  for (const [index, file] of derivedFiles.entries()) {
    if (!file?.path || !file?.sha256 || !allowedPaths.includes(file.path)) {
      issues.push(
        issue(
          "error",
          `versionMaterial.derivedFiles[${index}]`,
          "derived version material must have a path, digest, and matching allowed path",
        ),
      );
    }
  }
  for (const side of ["alpha", "release"]) {
    const material = Array.isArray(passport.versionMaterial[side]?.material)
      ? passport.versionMaterial[side].material
      : [];
    for (const [index, file] of material.entries()) {
      if (
        !file?.path ||
        !allowedPaths.includes(file.path) ||
        file.present !== true ||
        !/^sha256:[0-9a-f]{64}$/.test(file.sha256 || "")
      ) {
        issues.push(
          issue(
            "error",
            `versionMaterial.${side}.material[${index}]`,
            "version material must have an allowed path, present bytes, and sha256 digest",
          ),
        );
      }
    }
  }
}
