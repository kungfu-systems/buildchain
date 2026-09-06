import fs from "node:fs";
import path from "node:path";
import { verifyOciPublicationBundle } from "../packages/core/oci-publication-bundle.js";

export function resolveOciCandidate({ payloadRoot, passport }) {
  const matches = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("OCI candidate cannot contain symlinks");
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name === "oci-family.json") matches.push(file);
    }
  }
  visit(payloadRoot);
  if (matches.length !== 1)
    throw new Error("OCI candidate requires exactly one sealed image family");
  const manifest = JSON.parse(fs.readFileSync(matches[0]));
  const bundleRoot = path.dirname(matches[0]);
  const verified = verifyOciPublicationBundle({
    bundleRoot,
    manifest,
    repository: passport.repository,
    sourceSha: passport.source.headSha,
    version: passport.target.version,
  });
  return {
    root: bundleRoot,
    manifest: verified.manifest,
    requiredArtifacts: manifest.images.map((image) => ({
      kind: "oci",
      name: image.repository,
      ref: `v${manifest.version}`,
      digest: image.digest,
      platform: image.platform,
      required: true,
    })),
  };
}

export function resolveRecoveredPublicationVersion({
  artifactVersion,
  channel,
  rematerializeOnResume = false,
} = {}) {
  const version = String(artifactVersion || "").trim(),
    match = version.match(
      /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    );
  if (!match)
    throw new Error(
      `recovered npm artifact has invalid publication version: ${version || "<empty>"}`,
    );
  return channel === "release" && rematerializeOnResume ? match[1] : version;
}
export function resolveRecoveredCandidateVersion({
  artifactVersion,
  publicationVersion,
  channel,
  rematerializeOnResume = false,
  targetRef = "",
  candidateRef = "",
} = {}) {
  const version = String(artifactVersion || "").trim(),
    target = String(targetRef || "").replace(/^refs\/heads\//u, ""),
    candidate = String(candidateRef || "").replace(/^refs\/heads\//u, "");
  if (channel !== "release" || !rematerializeOnResume) return version;
  const prefix = `publish-gate/${target}/`;
  if (!target || !candidate.startsWith(prefix))
    throw new Error(
      `stable recovery candidate ref must descend from ${prefix || "publish-gate/<target>/"}`,
    );
  const candidateVersion = candidate.slice(prefix.length);
  if (!/^\d+\.\d+\.\d+-alpha\.\d+$/u.test(candidateVersion))
    throw new Error(
      `stable recovery candidate ref must bind an exact alpha version, got ${candidateVersion || "<empty>"}`,
    );
  if (candidateVersion.replace(/-alpha\.\d+$/u, "") !== publicationVersion)
    throw new Error(
      `stable recovery candidate ${candidateVersion} does not match publication ${publicationVersion || "<empty>"}`,
    );
  if (
    (version.match(
      /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    )?.[1] || "") !== publicationVersion
  )
    throw new Error(
      `recovered npm artifact version ${version || "<empty>"} does not match publication ${publicationVersion}`,
    );
  return candidateVersion;
}
