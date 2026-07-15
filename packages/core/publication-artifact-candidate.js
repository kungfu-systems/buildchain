import crypto from "node:crypto";

import { validateControllerReceipt } from "./controller-evidence.js";

export const PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT =
  "kungfu-buildchain-publication-artifact-candidate";

const MANIFEST_CONTRACT = "kungfu-buildchain-publication-artifact-manifest";
const PASSPORT_CONTRACT = "kungfu-buildchain-publication-artifact-passport";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function publicationArtifactCandidateDigest(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

export function resolvePublicationCandidateFile(files = [], candidatePath) {
  const normalizedPath = requiredString(candidatePath, "candidatePath").replaceAll("\\", "/");
  if (normalizedPath.startsWith("/") || normalizedPath.split("/").includes("..")) {
    throw new Error(`publication artifact candidate contains an unsafe path: ${normalizedPath}`);
  }
  const matches = files.filter((entry) => entry.path === normalizedPath);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one publication candidate file at ${normalizedPath}, found ${matches.length}`);
  }
  return matches[0].path;
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function normalizeDigest(value, label) {
  const normalized = requiredString(value, label).replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a sha256 digest`);
  return normalized;
}

function normalizeGitSha(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalized)) {
    throw new Error(`${label} must be a 40- or 64-character Git SHA`);
  }
  return normalized;
}

export function createPublicationArtifactCandidate({
  repository,
  sourceSha,
  sourceTreeSha,
  runtimeSha,
  manifest,
  passport,
  controllerReceipt,
  files = [],
} = {}) {
  const normalizedRepository = requiredString(repository, "repository");
  const normalizedSourceSha = normalizeGitSha(sourceSha, "sourceSha");
  const normalizedSourceTreeSha = normalizeGitSha(sourceTreeSha, "sourceTreeSha");
  const normalizedRuntimeSha = normalizeGitSha(runtimeSha, "runtimeSha");
  if (manifest?.contract !== MANIFEST_CONTRACT) throw new Error("publication artifact manifest contract mismatch");
  if (passport?.contract !== PASSPORT_CONTRACT || passport.status !== "passed") {
    throw new Error("publication artifact passport is not qualifying");
  }
  if (manifest.source?.sha !== normalizedSourceSha || passport.source?.sha !== normalizedSourceSha) {
    throw new Error("publication artifact source SHA mismatch");
  }
  if (manifest.source?.treeSha !== normalizedSourceTreeSha || passport.source?.treeSha !== normalizedSourceTreeSha) {
    throw new Error("publication artifact source tree mismatch");
  }
  const manifestDigest = crypto.createHash("sha256").update(JSON.stringify(manifest, null, 2)).digest("hex");
  if (normalizeDigest(passport.manifestDigest, "passport.manifestDigest") !== manifestDigest) {
    throw new Error("publication artifact passport manifest digest mismatch");
  }
  const controllerValidation = validateControllerReceipt(controllerReceipt, {
    expectedSourceSha: normalizedSourceSha,
    expectedRuntimeSha: normalizedRuntimeSha,
  });
  if (!controllerValidation.ok || !controllerValidation.qualifying) {
    throw new Error(`publication artifact controller receipt did not qualify: ${controllerValidation.issues.join("; ")}`);
  }
  const evidenceKinds = new Set((controllerReceipt.evidence || []).map((entry) => entry.kind));
  for (const kind of ["publication-manifest", "publication-passport"]) {
    if (!evidenceKinds.has(kind)) throw new Error(`publication artifact controller receipt is missing ${kind} evidence`);
  }
  const normalizedFiles = files.map((entry, index) => {
    const filePath = requiredString(entry.path, `files[${index}].path`).replaceAll("\\", "/");
    if (filePath.startsWith("/") || filePath.split("/").includes("..")) {
      throw new Error(`publication artifact candidate contains an unsafe path: ${filePath}`);
    }
    const size = Number(entry.size ?? entry.bytes);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`files[${index}].size must be a non-negative safe integer`);
    return { path: filePath, size, sha256: normalizeDigest(entry.sha256, `files[${index}].sha256`) };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(normalizedFiles.map((entry) => entry.path)).size !== normalizedFiles.length) {
    throw new Error("publication artifact candidate file paths must be unique");
  }
  const byPath = new Map(normalizedFiles.map((entry) => [entry.path, entry]));
  for (const [index, artifact] of (manifest.artifacts || []).entries()) {
    const artifactPath = requiredString(artifact.path, `manifest.artifacts[${index}].path`);
    const actual = byPath.get(artifactPath);
    if (!actual) throw new Error(`publication artifact candidate is missing declared artifact: ${artifactPath}`);
    if (actual.size !== Number(artifact.bytes) || actual.sha256 !== normalizeDigest(artifact.sha256, `manifest.artifacts[${index}].sha256`)) {
      throw new Error(`publication artifact candidate bytes do not match manifest: ${artifactPath}`);
    }
  }
  const payload = {
    schemaVersion: 1,
    contract: PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
    repository: normalizedRepository,
    sourceSha: normalizedSourceSha,
    sourceTreeSha: normalizedSourceTreeSha,
    runtimeSha: normalizedRuntimeSha,
    manifestDigest,
    passportDigest: publicationArtifactCandidateDigest(passport),
    controllerReceiptDigest: normalizeDigest(controllerReceipt.digest, "controllerReceipt.digest"),
    files: normalizedFiles,
  };
  return { ...payload, candidateDigest: publicationArtifactCandidateDigest(payload) };
}
