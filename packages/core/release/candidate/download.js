import { githubDownload, verifyArtifactArchive, unzip } from "./transport.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export async function downloadCandidateArtifacts({
  outputDir,
  repoInfo,
  selected,
  payloadArtifacts,
  apiUrl,
  token,
  fetchImpl,
}) {
  const resolvedOutput = path.resolve(outputDir);
  fs.mkdirSync(resolvedOutput, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-rc-"));
  const passportDir = path.join(resolvedOutput, "passport");
  const summaryDir = path.join(resolvedOutput, "summary");
  const payloadDir = path.join(resolvedOutput, "payloads");
  const passportZip = path.join(tempDir, "passport.zip");
  const summaryZip = path.join(tempDir, "summary.zip");
  await githubDownload({
    apiUrl,
    token,
    fetchImpl,
    outputPath: passportZip,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/artifacts/${selected.passport.id}/zip`,
  });
  verifyArtifactArchive({
    artifact: selected.passport,
    archivePath: passportZip,
  });
  await githubDownload({
    apiUrl,
    token,
    fetchImpl,
    outputPath: summaryZip,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/artifacts/${selected.summary.id}/zip`,
  });
  verifyArtifactArchive({
    artifact: selected.summary,
    archivePath: summaryZip,
  });
  for (const artifact of payloadArtifacts) {
    const safeName = String(artifact.name || `artifact-${artifact.id}`).replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    const payloadZip = path.join(tempDir, `${safeName}.zip`);
    await githubDownload({
      apiUrl,
      token,
      fetchImpl,
      outputPath: payloadZip,
      path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/artifacts/${artifact.id}/zip`,
    });
    verifyArtifactArchive({ artifact, archivePath: payloadZip });
    unzip(payloadZip, path.join(payloadDir, safeName));
  }
  unzip(passportZip, passportDir);
  unzip(summaryZip, summaryDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
  return { resolvedOutput, passportDir, summaryDir, payloadDir };
}
