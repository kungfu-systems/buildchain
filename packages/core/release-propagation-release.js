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
    gitHead: pkg.gitHead || pkg.git_head
      ? assertCommitSha(pkg.gitHead || pkg.git_head, "upstreamRelease.package.gitHead")
      : "",
  };
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(normalized.integrity)) {
    throw new Error("upstreamRelease.package.integrity must be an exact sha512 SRI value");
  }
  return normalized;
}

function normalizeRegistryProvenance(value, packageFact, repository, sourceSha) {
  if (!value) return undefined;
  if (!packageFact) throw new Error("upstreamRelease.registryProvenance requires package");
  const input = assertPlainObject(value, "upstreamRelease.registryProvenance");
  const normalized = {
    registry: assertString(input.registry, "upstreamRelease.registryProvenance.registry"),
    attestationUrl: assertString(input.attestationUrl || input.attestation_url, "upstreamRelease.registryProvenance.attestationUrl"),
    predicateType: assertString(input.predicateType || input.predicate_type, "upstreamRelease.registryProvenance.predicateType"),
    subjectSha512: assertString(input.subjectSha512 || input.subject_sha512, "upstreamRelease.registryProvenance.subjectSha512"),
    repository: assertString(input.repository, "upstreamRelease.registryProvenance.repository"),
    sourceSha: assertCommitSha(input.sourceSha || input.source_sha, "upstreamRelease.registryProvenance.sourceSha"),
    workflowPath: assertString(input.workflowPath || input.workflow_path, "upstreamRelease.registryProvenance.workflowPath"),
    workflowRef: assertString(input.workflowRef || input.workflow_ref, "upstreamRelease.registryProvenance.workflowRef"),
    runUrl: assertString(input.runUrl || input.run_url, "upstreamRelease.registryProvenance.runUrl"),
  };
  if (normalized.registry !== "https://registry.npmjs.org") throw new Error("upstreamRelease.registryProvenance.registry must be the public npm registry");
  if (!normalized.attestationUrl.startsWith("https://registry.npmjs.org/-/npm/v1/attestations/")) throw new Error("upstreamRelease.registryProvenance.attestationUrl must use the npm attestation API");
  if (normalized.predicateType !== "https://slsa.dev/provenance/v1") throw new Error("upstreamRelease.registryProvenance must use SLSA provenance v1");
  if (!/^[0-9a-f]{128}$/.test(normalized.subjectSha512)) throw new Error("upstreamRelease.registryProvenance.subjectSha512 must be an exact SHA-512 digest");
  const sriDigest = Buffer.from(packageFact.integrity.slice("sha512-".length), "base64").toString("hex");
  if (normalized.subjectSha512 !== sriDigest) throw new Error("upstreamRelease registry provenance subject must match package integrity");
  if (normalized.repository !== repository || normalized.sourceSha !== sourceSha) throw new Error("upstreamRelease registry provenance source must match the release envelope");
  return normalized;
}

function normalizeReleaseEvidence(release, packageFact, repository, sourceSha, version) {
  const registryProvenance = normalizeRegistryProvenance(
    release.registryProvenance || release.registry_provenance,
    packageFact,
    repository,
    sourceSha,
  );
  const tag = optionalString(release.tag);
  const target = release.tagTargetSha || release.tag_target_sha;
  const tagTargetSha = target ? assertCommitSha(target, "upstreamRelease.tagTargetSha") : "";
  if (!registryProvenance) {
    if (tag !== `v${version}`) throw new Error("upstreamRelease.tag must exactly match the published version");
    if (tagTargetSha !== sourceSha) throw new Error("upstreamRelease tag target must match sourceSha");
    if (packageFact && packageFact.gitHead !== sourceSha) throw new Error("upstreamRelease package gitHead must match sourceSha");
  } else if ((tag && tag !== `v${version}`) || (tagTargetSha && tagTargetSha !== sourceSha)) {
    throw new Error("upstreamRelease optional tag evidence must match the provenance source");
  }
  const passportInput = release.releasePassport || release.release_passport;
  return {
    tag,
    tagTargetSha,
    registryProvenance,
    releasePassport: passportInput ? normalizeReleasePassport(passportInput) : undefined,
  };
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
  const evidence = normalizeReleaseEvidence(release, packageFact, repository, sourceSha, version);
  if (!evidence.registryProvenance && !evidence.releasePassport) normalizeReleasePassport();
  if (packageFact && publicationArtifact && packageFact.version !== publicationArtifact.version) {
    throw new Error("upstreamRelease package and publication artifact versions must match");
  }
  return {
    repository,
    channel: normalizeChannel(release.channel, "upstreamRelease.channel"),
    tag: evidence.tag,
    tagTargetSha: evidence.tagTargetSha,
    sourceSha,
    package: packageFact,
    publicationArtifact,
    releasePassport: evidence.releasePassport,
    registryProvenance: evidence.registryProvenance,
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

export function verifyReleaseLockBinding({ release, lock, downstream, propagationKey }) {
  const normalizedRelease = normalizeUpstreamRelease(release);
  const lockRelease = normalizeUpstreamRelease({
    repository: lock.upstream?.repository,
    channel: lock.upstream?.channel,
    tag: lock.upstream?.tag,
    tagTargetSha: lock.upstream?.tagTargetSha,
    sourceSha: lock.upstream?.sourceSha,
    package: lock.upstream?.package,
    publicationArtifact: lock.upstream?.publicationArtifact,
    releasePassport: lock.upstream?.releasePassport,
    registryProvenance: lock.upstream?.registryProvenance,
    siteBundle: lock.upstream?.siteBundle,
  });
  if (JSON.stringify(lockRelease) !== JSON.stringify(normalizedRelease)) {
    throw new Error("release propagation work upstream release disagrees with its lock");
  }
  const expectedCoordinates = {
    target: lock.downstream?.node,
    repository: lock.downstream?.repository,
    channel: lock.downstream?.channel,
    baseRef: lock.downstream?.baseRef,
    branch: lock.propagation?.branch,
    lockPath: lock.downstream?.lockPath,
    propagationKey: lock.propagation?.propagationKey,
  };
  const actualCoordinates = {
    target: downstream.target,
    repository: downstream.repository,
    channel: downstream.channel,
    baseRef: downstream.baseRef,
    branch: downstream.branch,
    lockPath: downstream.lockPath,
    propagationKey,
  };
  if (JSON.stringify(actualCoordinates) !== JSON.stringify(expectedCoordinates)) {
    throw new Error("release propagation work downstream coordinates disagree with its lock");
  }
  return normalizedRelease;
}
