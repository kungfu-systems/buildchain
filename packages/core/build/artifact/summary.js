import crypto from "node:crypto";
import path from "node:path";
export function createArtifactSummary({ artifactName, platform, files }) {
  const totalBytes = files.reduce(
    (sum, file) => sum + Number(file.size || 0),
    0,
  );
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    digest.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  }
  return {
    contract: "kungfu-buildchain-artifact-summary",
    artifactName,
    platform,
    fileCount: files.length,
    totalBytes,
    digest: digest.digest("hex"),
  };
}
