import { getPublishContract } from "../../../consumer/buildchain-config.js";
export function npmPackageSpec(artifact) {
  return `${artifact.name}@${artifact.ref}`;
}
export function isAlphaLikeVersion(version) {
  return /(?:^|[-.])alpha(?:[-.]|$)/i.test(String(version || ""));
}
export function defaultDistTagForChannel(channel) {
  return channel === "alpha" ? "alpha" : "latest";
}
export function releaseLineMajor(line) {
  const match = String(line || "").match(/^v(\d+)\.\d+$/);
  return match ? Number(match[1]) : undefined;
}
export function alphaDistTagForPromotion({
  ownsMajorAlphaTag,
  line,
  publishDistTag = "",
  sharedAlphaAuthorityMajor,
} = {}) {
  const major = releaseLineMajor(line);
  if (major === undefined) {
    throw new Error(
      `alpha publication requires a vN.N release line; got ${line || "<empty>"}`,
    );
  }
  const ownsSharedAlphaAuthority =
    ownsMajorAlphaTag &&
    (!sharedAlphaAuthorityMajor || major === sharedAlphaAuthorityMajor);
  if (ownsSharedAlphaAuthority) {
    return publishDistTag;
  }
  if (publishDistTag === "alpha") {
    throw new Error(
      `shared npm alpha authority belongs to v${sharedAlphaAuthorityMajor}; ${line} must use its line-specific dist-tag`,
    );
  }
  return publishDistTag || `${line}-alpha`;
}
export function resolvePublishContract({
  loadedConfig,
  channel,
  line = "",
  publishMode = "",
  publishAuth = "",
  publishDistTag = "",
  publishPackageSetOrder = "",
  publishPackageMain = "",
} = {}) {
  const configured = getPublishContract(loadedConfig) || {};
  const mode = publishMode || configured.mode || "publish-final-version";
  const auth = publishAuth || configured.auth || "trusted-publishing";
  const packageSetOrder =
    publishPackageSetOrder || configured.packageSetOrder || "as-provided";
  const mainPackage = publishPackageMain || configured.mainPackage || "";
  const distTag =
    publishDistTag || configured.distTag || defaultDistTagForChannel(channel);
  const sharedAlphaAuthorityMajor = configured.sharedAlphaAuthorityMajor;
  validatePublishMode({ mode, auth, packageSetOrder, channel, distTag });
  const alphaDistTags = new Set(["alpha", ...(line ? [`${line}-alpha`] : [])]);
  if (
    channel === "alpha" &&
    distTag === "alpha" &&
    sharedAlphaAuthorityMajor &&
    releaseLineMajor(line) !== sharedAlphaAuthorityMajor
  ) {
    throw new Error(
      `shared npm alpha authority belongs to v${sharedAlphaAuthorityMajor}; ${line || "<unknown line>"} must use its line-specific dist-tag`,
    );
  }
  if (
    channel === "alpha" &&
    mode === "publish-final-version" &&
    !alphaDistTags.has(distTag)
  ) {
    throw new Error(
      `alpha publish-final-version must use dist-tag alpha or ${line ? `${line}-alpha` : "the line-specific alpha tag"}`,
    );
  }
  return {
    mode,
    auth,
    distTag,
    sharedAlphaAuthorityMajor,
    packageSetOrder,
    mainPackage,
  };
}
export function allRequiredArtifactsAreNpm(requiredArtifacts) {
  return (
    requiredArtifacts.length > 0 &&
    requiredArtifacts.every(
      (artifact) => artifact.kind === "npm" && artifact.name && artifact.ref,
    )
  );
}
export function orderNpmArtifactsForPackageSet({ artifacts, contract }) {
  if (contract.packageSetOrder !== "platforms-first-main-last") {
    return artifacts;
  }
  const mainPackage = contract.mainPackage;
  return [
    ...artifacts.filter(
      (artifact) => artifact.role !== "main" && artifact.name !== mainPackage,
    ),
    ...artifacts.filter(
      (artifact) => artifact.role === "main" || artifact.name === mainPackage,
    ),
  ];
}
export function validatePublishContractForArtifacts({
  channel,
  contract,
  requiredArtifacts,
}) {
  if (
    contract.mode === "promote-existing-version" &&
    !allRequiredArtifactsAreNpm(requiredArtifacts)
  ) {
    throw new Error(
      "promote-existing-version requires npm publish-required-artifacts-json entries",
    );
  }
  if (contract.packageSetOrder === "platforms-first-main-last") {
    const mainArtifacts = requiredArtifacts.filter(
      (artifact) =>
        artifact.role === "main" || artifact.name === contract.mainPackage,
    );
    if (mainArtifacts.length !== 1) {
      throw new Error(
        "platforms-first-main-last package set requires exactly one main npm artifact",
      );
    }
  }
  if (channel === "release" && contract.mode === "publish-final-version") {
    const alphaArtifacts = requiredArtifacts.filter((artifact) =>
      isAlphaLikeVersion(artifact.ref),
    );
    if (alphaArtifacts.length > 0) {
      throw new Error(
        "release publish-final-version must publish final package refs, not alpha refs",
      );
    }
  }
}

function validatePublishMode({
  mode,
  auth,
  packageSetOrder,
  channel,
  distTag,
}) {
  if (!["publish-final-version", "promote-existing-version"].includes(mode)) {
    throw new Error(
      "publish mode must be one of publish-final-version or promote-existing-version",
    );
  }
  if (!["trusted-publishing", "npm-token"].includes(auth)) {
    throw new Error(
      "publish auth must be one of trusted-publishing or npm-token",
    );
  }
  if (!["as-provided", "platforms-first-main-last"].includes(packageSetOrder)) {
    throw new Error(
      "publish package set order must be one of as-provided or platforms-first-main-last",
    );
  }
  if (mode === "promote-existing-version" && auth !== "npm-token") {
    throw new Error(
      "promote-existing-version requires npm-token auth; Trusted Publishing cannot authorize npm dist-tag add",
    );
  }
  if (
    channel === "release" &&
    mode === "publish-final-version" &&
    distTag !== "latest"
  ) {
    throw new Error("release publish-final-version must use dist-tag latest");
  }
}
