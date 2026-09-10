import { safeName } from "./files.js";
import { collectFiles } from "./files.js";
import { readOnlyJson } from "./files.js";
import { candidateArtifactNames } from "./artifacts.js";
import fs from "node:fs";
import path from "node:path";
import { selectReleaseCandidateArtifacts } from "../candidate/selection.js";
import { unzip } from "../candidate/transport.js";
import { verifyArtifactArchive } from "../candidate/transport.js";
import { githubDownload } from "./../candidate/transport.js";
import { githubJson } from "./../candidate/transport.js";
import { outputPath } from "../candidate/payloads.js";
export async function downloadArtifact({
  artifact,
  repoInfo,
  apiUrl,
  token,
  archiveDir,
  bundleRoot,
  fetchImpl,
}) {
  const name = safeName(artifact.name);
  const archivePath = path.join(archiveDir, `${name}.zip`);
  const artifactRoot = path.join(bundleRoot, "artifacts", name);
  await githubDownload({
    apiUrl,
    token,
    fetchImpl,
    outputPath: archivePath,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/artifacts/${artifact.id}/zip`,
  });
  const archive = verifyArtifactArchive({ artifact, archivePath });
  try {
    unzip(archivePath, artifactRoot);
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
  const files = collectFiles(artifactRoot);
  return {
    artifact,
    artifactRoot,
    record: {
      name: artifact.name,
      kind: "candidate",
      size: Number(artifact.size_in_bytes),
      downloadedSize: archive.size,
      digest: artifact.digest,
      downloadedDigest: archive.digest,
      expired: artifact.expired === true,
      files: files.map(({ path: filePath, size, sha256 }) => ({
        path: filePath,
        size,
        sha256,
      })),
    },
    files,
  };
}

export async function recoverCandidateEvidence({
  repoInfo,
  runId,
  artifactName,
  artifactPatterns,
  requiredArtifactCount,
  outputDir,
  apiUrl,
  token,
  fetchImpl,
  archiveDir,
}) {
  const run = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/runs/${runId}`,
  });
  const workflow = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/workflows/${run.workflow_id}`,
  });
  const artifactResponse = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/runs/${runId}/artifacts?per_page=100`,
  });
  const artifacts = Array.isArray(artifactResponse.artifacts)
    ? artifactResponse.artifacts
    : [];
  if (
    Number(artifactResponse.total_count || artifacts.length) !==
    artifacts.length
  )
    throw new Error(
      "candidate run has more than 100 artifacts; complete pagination is required before recovery",
    );
  const selected = selectReleaseCandidateArtifacts({ artifacts, artifactName });
  const resolvedOutput = path.resolve(outputDir);
  const bundleRoot = path.join(resolvedOutput, "sealed-candidate");
  fs.mkdirSync(bundleRoot, { recursive: true });
  const initialDownloads = [];
  for (const artifact of [selected.passport, selected.summary])
    initialDownloads.push(
      await downloadArtifact({
        artifact,
        repoInfo,
        apiUrl,
        token,
        archiveDir,
        bundleRoot,
        fetchImpl,
      }),
    );
  const passport = readOnlyJson(
    initialDownloads[0].files.filter(
      (file) => path.basename(file.path) === "release-candidate-passport.json",
    ),
    "release-candidate-passport.json",
  );
  const buildSummary = readOnlyJson(
    initialDownloads[1].files.filter(
      (file) => path.basename(file.path) === "build-summary.json",
    ),
    "build-summary.json",
  );
  const [stageCapsuleFile, publicationQualificationFile] = [
    "release-candidate-stage-capsules.json",
    "release-candidate-publication-qualification.json",
  ].map((name) =>
    initialDownloads[0].files.find((file) => path.basename(file.path) === name),
  );
  const stageCapsuleSidecar = stageCapsuleFile
    ? readOnlyJson([stageCapsuleFile], "release-candidate-stage-capsules.json")
    : undefined;
  const { names: requiredNames, publicationNames } = candidateArtifactNames({
    passport,
    selected,
    artifacts,
    artifactPatterns,
  });
  const chosen = artifacts.filter((artifact) =>
    requiredNames.has(artifact.name),
  );
  if (chosen.length !== requiredNames.size) {
    const found = new Set(chosen.map((artifact) => artifact.name));
    throw new Error(
      `candidate artifacts are missing: ${[...requiredNames].filter((name) => !found.has(name)).join(", ")}`,
    );
  }
  if (
    Number(requiredArtifactCount || 0) > 0 &&
    chosen.length < Number(requiredArtifactCount)
  )
    throw new Error(
      `candidate artifact count ${chosen.length} is below required ${requiredArtifactCount}`,
    );
  const downloads = [...initialDownloads];
  for (const artifact of chosen.filter(
    (entry) => ![selected.passport.id, selected.summary.id].includes(entry.id),
  ))
    downloads.push(
      await downloadArtifact({
        artifact,
        repoInfo,
        apiUrl,
        token,
        archiveDir,
        bundleRoot,
        fetchImpl,
      }),
    );
  return {
    run,
    workflow,
    selected,
    resolvedOutput,
    bundleRoot,
    initialDownloads,
    passport,
    buildSummary,
    stageCapsuleSidecar,
    stageCapsuleFile,
    publicationQualificationFile,
    chosen,
    downloads,
    publicationNames,
  };
}
