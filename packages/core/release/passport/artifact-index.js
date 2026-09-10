import { optionalString } from "./identity.js";
export function artifactDigestValue(artifact = {}) {
  return optionalString(
    artifact.digest || artifact.sha256 || artifact.integrity || artifact.shasum,
  );
}
export function equivalentDigest(left, right) {
  if (!left || !right) {
    return false;
  }
  return (
    left === right || left === `sha256:${right}` || `sha256:${left}` === right
  );
}
export function artifactEvidenceKeys(artifact = {}) {
  const name = optionalString(artifact.name);
  if (!name) {
    return [];
  }
  const group = optionalString(artifact.group);
  const kind = optionalString(artifact.kind);
  const ref = optionalString(artifact.ref || artifact.version);
  const keys = [];
  if (group || kind || ref) {
    keys.push(["structured", group, kind, name, ref].join("\0"));
  }
  if (kind || ref) {
    keys.push(["structured", "", kind, name, ref].join("\0"));
  }
  if (kind) {
    keys.push(["structured", "", kind, name, ""].join("\0"));
  }
  keys.push(["name", name].join("\0"));
  return keys;
}
export function indexEvidenceArtifacts(artifacts = []) {
  const index = new Map();
  for (const artifact of artifacts) {
    for (const key of artifactEvidenceKeys(artifact)) {
      const entries = index.get(key) || [];
      entries.push(artifact);
      index.set(key, entries);
    }
  }
  return index;
}
export function findEvidenceForArtifact(artifact, evidenceIndex) {
  const artifactDigest = artifactDigestValue(artifact);
  for (const key of artifactEvidenceKeys(artifact)) {
    const entries = evidenceIndex.get(key) || [];
    if (entries.length === 0) {
      continue;
    }
    const matchingDigest = entries.find((entry) =>
      equivalentDigest(artifactDigest, artifactDigestValue(entry)),
    );
    if (matchingDigest) {
      return matchingDigest;
    }
    if (!key.startsWith("name\0") || entries.length === 1) {
      return entries[0];
    }
  }
  return undefined;
}
