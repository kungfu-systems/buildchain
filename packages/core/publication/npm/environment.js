// Translate the governed publication process protocol at its boundary.
export function npmPublicationEnvironment(env) {
  return {
    version: env.BUILDCHAIN_VERSION || "",
    distTag: env.BUILDCHAIN_NPM_DIST_TAG || "",
    evidencePath: env.BUILDCHAIN_PUBLISH_EVIDENCE || "",
    channel: env.BUILDCHAIN_CHANNEL || "",
    sourceSha: env.BUILDCHAIN_SOURCE_SHA || "",
    releaseSha: env.BUILDCHAIN_RELEASE_SHA || "",
    targetRef: env.BUILDCHAIN_TARGET_REF || "",
    releaseMaterialSha: env.BUILDCHAIN_RELEASE_MATERIAL_SHA || "",
    publishToolingSha: env.BUILDCHAIN_PUBLISH_TOOLING_SHA || "",
    sealedBundleRoot: env.BUILDCHAIN_SEALED_BUNDLE_ROOT || "",
    tarballPath: env.BUILDCHAIN_SEALED_NPM_TARBALL || "",
    integrity: env.BUILDCHAIN_SEALED_NPM_INTEGRITY || "",
    sha256: env.BUILDCHAIN_SEALED_NPM_SHA256 || "",
  };
}
