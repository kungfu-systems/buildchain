import {
  assertPlainObject,
  assertString,
  normalizeChannel,
  optionalString,
} from "./release-propagation-common.js";
import { assertCommitSha } from "./release-propagation-work-control.js";

function normalizeReleasePassport(passport = {}) {
  if (!passport || typeof passport !== "object" || Array.isArray(passport)) {
    throw new Error("upstreamRelease.releasePassport must be an object");
  }
  const normalized = {
    url: assertString(passport.url, "upstreamRelease.releasePassport.url"),
    sha256: assertString(passport.sha256 || passport.digest, "upstreamRelease.releasePassport.sha256"),
  };
  if (!/^[0-9a-f]{64}$/.test(normalized.sha256)) {
    throw new Error("upstreamRelease.releasePassport.sha256 must be an exact SHA-256 digest");
  }
  if (/[?&](?:token|signature|x-amz-|x-goog-)/i.test(normalized.url)) {
    throw new Error("upstreamRelease.releasePassport.url must not contain signed or credential parameters");
  }
  return normalized;
}

function normalizePackageFact(pkg = {}) {
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw new Error("upstreamRelease.package must be an object");
  }
  const normalized = {
    name: assertString(pkg.name, "upstreamRelease.package.name"),
    version: assertString(pkg.version, "upstreamRelease.package.version"),
    integrity: assertString(pkg.integrity, "upstreamRelease.package.integrity"),
    gitHead: assertCommitSha(pkg.gitHead || pkg.git_head, "upstreamRelease.package.gitHead"),
  };
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(normalized.integrity)) {
    throw new Error("upstreamRelease.package.integrity must be an exact sha512 SRI value");
  }
  return normalized;
}

function normalizeDigestUrlFact(value = {}, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const normalized = {
    url: assertString(value.url, `${label}.url`),
    sha256: assertString(value.sha256 || value.digest, `${label}.sha256`),
  };
  if (!/^[0-9a-f]{64}$/.test(normalized.sha256)) {
    throw new Error(`${label}.sha256 must be an exact SHA-256 digest`);
  }
  if (/[?&](?:token|signature|x-amz-|x-goog-)/i.test(normalized.url)) {
    throw new Error(`${label}.url must not contain signed or credential parameters`);
  }
  return normalized;
}

function normalizeOptionalPathDigestUrlFact(value = undefined, label) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = normalizeDigestUrlFact(value, label);
  return {
    path: optionalString(value.path),
    bytes: value.bytes === undefined ? undefined : Number(value.bytes),
    ...normalized,
  };
}

function normalizePublicationArtifactFact(value = undefined) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const artifact = assertPlainObject(value, "upstreamRelease.publicationArtifact");
  return {
    id: optionalString(artifact.id),
    kind: optionalString(artifact.kind),
    version: assertString(artifact.version, "upstreamRelease.publicationArtifact.version"),
    canonicalUrl: assertString(
      artifact.canonicalUrl || artifact.canonical_url,
      "upstreamRelease.publicationArtifact.canonicalUrl",
    ),
    latestUrl: assertString(
      artifact.latestUrl || artifact.latest_url,
      "upstreamRelease.publicationArtifact.latestUrl",
    ),
    latestEvidenceUrl: optionalString(artifact.latestEvidenceUrl || artifact.latest_evidence_url),
    immutableVersionUrl: assertString(
      artifact.immutableVersionUrl || artifact.immutable_version_url || artifact.immutableVersionPrefix || artifact.immutable_version_prefix,
      "upstreamRelease.publicationArtifact.immutableVersionUrl",
    ),
    immutableVersionPrefix: optionalString(artifact.immutableVersionPrefix || artifact.immutable_version_prefix),
    registry: normalizeDigestUrlFact(artifact.registry, "upstreamRelease.publicationArtifact.registry"),
    manifest: normalizeDigestUrlFact(artifact.manifest, "upstreamRelease.publicationArtifact.manifest"),
    passport: normalizeDigestUrlFact(artifact.passport, "upstreamRelease.publicationArtifact.passport"),
    primaryArtifact: normalizeOptionalPathDigestUrlFact(
      artifact.primaryArtifact || artifact.primary_artifact,
      "upstreamRelease.publicationArtifact.primaryArtifact",
    ),
    sourceBundle: normalizeOptionalPathDigestUrlFact(
      artifact.sourceBundle || artifact.source_bundle,
      "upstreamRelease.publicationArtifact.sourceBundle",
    ),
  };
}

export function normalizeUpstreamRelease(input) {
  const release = assertPlainObject(input, "upstreamRelease");
  const publicationArtifact = normalizePublicationArtifactFact(release.publicationArtifact || release.publication_artifact);
  const packageFact = release.package === undefined ? undefined : normalizePackageFact(release.package);
  if (!packageFact && !publicationArtifact) {
    throw new Error("upstreamRelease requires package or publicationArtifact");
  }
  const repository = assertString(release.repository, "upstreamRelease.repository");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("upstreamRelease.repository must be owner/repo");
  }
  const sourceSha = assertCommitSha(release.sourceSha || release.source_sha, "upstreamRelease.sourceSha");
  const version = packageFact?.version || publicationArtifact?.version || "";
  const tag = assertString(release.tag, "upstreamRelease.tag");
  if (tag !== `v${version}`) {
    throw new Error("upstreamRelease.tag must exactly match the published version");
  }
  if (packageFact && packageFact.gitHead !== sourceSha) {
    throw new Error("upstreamRelease package gitHead must match sourceSha");
  }
  if (packageFact && publicationArtifact && packageFact.version !== publicationArtifact.version) {
    throw new Error("upstreamRelease package and publication artifact versions must match");
  }
  return {
    repository,
    channel: normalizeChannel(release.channel, "upstreamRelease.channel"),
    tag,
    sourceSha,
    package: packageFact,
    publicationArtifact,
    releasePassport: normalizeReleasePassport(release.releasePassport || release.release_passport),
    siteBundle: release.siteBundle || release.site_bundle
      ? {
        manifestSha256: assertString(
          release.siteBundle?.manifestSha256 || release.site_bundle?.manifest_sha256,
          "upstreamRelease.siteBundle.manifestSha256",
        ),
      }
      : undefined,
  };
}

