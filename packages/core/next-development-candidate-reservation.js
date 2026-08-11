// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

const SHA = /^[0-9a-f]{40}$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;

function text(value = "") {
  return String(value ?? "").trim();
}

function exactSha(value, label) {
  const normalized = text(value).toLowerCase();
  if (!SHA.test(normalized)) {
    throw new Error(`${label} must be an exact 40-character SHA`);
  }
  return normalized;
}

function exactRoot(value, label) {
  const normalized = text(value).toLowerCase();
  if (!ROOT.test(normalized)) {
    throw new Error(`${label} must be an exact sha256 content root`);
  }
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function evidenceRoot(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

export function nextDevelopmentPreparedVersion(message) {
  const title = text(message).split("\n", 1)[0];
  return (
    title.match(
      /^(?:chore\(release\): prepare|Prepare)\s+v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/u,
    )?.[1] || ""
  );
}

function preparation(entry) {
  if (!entry || typeof entry === "string") return undefined;
  const targetVersion = nextDevelopmentPreparedVersion(entry.message);
  if (!targetVersion) return undefined;
  return {
    sha: exactSha(entry.sha, "sourceHistory.sha"),
    targetVersion,
  };
}

export function nextDevelopmentPatrolContext(sourceHistory) {
  const preparations = sourceHistory
    .map((entry, index) => ({ index, preparation: preparation(entry) }))
    .filter((entry) => entry.preparation);
  const preparationShas = new Set(
    preparations.map(({ preparation: item }) => item.sha),
  );
  const integrationShas = sourceHistory
    .filter(
      (entry) =>
        entry &&
        typeof entry !== "string" &&
        Array.isArray(entry.parents) &&
        entry.parents.length === 2 &&
        entry.parents.some((parent) => preparationShas.has(parent)),
    )
    .map((entry) => exactSha(entry.sha, "sourceHistory.sha"));
  return {
    preparations,
    ignoredSourceShas: [...preparationShas, ...integrationShas],
  };
}

export function normalizeNextDevelopmentVersionReservation(input, expected) {
  const status = text(input?.status);
  if (!["current", "absent", "stale"].includes(status)) {
    throw new Error("next-development version reservation status is invalid");
  }
  const normalized = {
    status,
    reservationSha: exactSha(
      input?.reservationSha,
      "versionReservation.reservationSha",
    ),
    candidateSha: exactSha(
      input?.candidateSha,
      "versionReservation.candidateSha",
    ),
    targetVersion: text(input?.targetVersion),
    paths: [...new Set((input?.paths || []).map(text))].sort(),
    evidenceRoot: exactRoot(
      input?.evidenceRoot,
      "versionReservation.evidenceRoot",
    ),
  };
  if (
    normalized.reservationSha !== expected.reservationSha ||
    normalized.candidateSha !== expected.candidateSha ||
    normalized.targetVersion !== expected.targetVersion
  ) {
    throw new Error("next-development version reservation identity drifted");
  }
  if (normalized.paths.length === 0 || normalized.paths.some((path) => !path)) {
    throw new Error("next-development version reservation paths are required");
  }
  return normalized;
}

function encodeRepositoryPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

export async function readGitHubNextDevelopmentVersionReservation({
  api,
  owner,
  repo,
  reservationSha,
  candidateSha,
  targetVersion,
}) {
  const commit = await api(
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(reservationSha)}`,
  );
  if (
    text(commit.sha) !== reservationSha ||
    nextDevelopmentPreparedVersion(commit.commit?.message) !== targetVersion
  ) {
    throw new Error(
      "next-development preparation commit identity or version drifted",
    );
  }
  const paths = [
    ...new Set((commit.files || []).map((file) => text(file.filename))),
  ]
    .filter(Boolean)
    .sort();
  if (paths.length === 0) {
    throw new Error(
      "next-development preparation commit has no version-state paths",
    );
  }
  const observations = [];
  let status = "current";
  for (const filePath of paths) {
    const endpoint = `/repos/${owner}/${repo}/contents/${encodeRepositoryPath(filePath)}`;
    const prepared = await api(
      `${endpoint}?ref=${encodeURIComponent(reservationSha)}`,
      { allow404: true },
    );
    const candidate = await api(
      `${endpoint}?ref=${encodeURIComponent(candidateSha)}`,
      { allow404: true },
    );
    const preparedBlob =
      text(prepared?.type) === "file" ? text(prepared?.sha) : "";
    const candidateBlob =
      text(candidate?.type) === "file" ? text(candidate?.sha) : "";
    if (!candidateBlob) status = "absent";
    else if (!preparedBlob || candidateBlob !== preparedBlob) status = "stale";
    observations.push({ path: filePath, preparedBlob, candidateBlob });
  }
  const body = {
    status,
    reservationSha,
    candidateSha,
    targetVersion,
    paths,
    observations,
  };
  return { ...body, evidenceRoot: evidenceRoot(body) };
}
