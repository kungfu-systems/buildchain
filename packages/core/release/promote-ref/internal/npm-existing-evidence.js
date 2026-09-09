import { npmPackageSpec } from "./publish-contract.js";
import { execNpmSync } from "./npm-distribution.js";
import fs from "node:fs";
import path from "node:path";
export function readExistingNpmIntegrity({ cwd, artifact }) {
  const spec = npmPackageSpec(artifact);
  try {
    const output = execNpmSync(["view", spec, "dist.integrity", "--json"], {
      cwd,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!output) {
      throw new Error("empty dist.integrity");
    }
    return JSON.parse(output);
  } catch (error) {
    const message = error.stderr?.toString?.().trim() || error.message;
    throw new Error(
      `existing npm artifact is required for release promotion: ${spec}: ${message}`,
    );
  }
}
export function resolveExistingNpmArtifacts({ cwd, requiredArtifacts }) {
  return requiredArtifacts.map((artifact) => ({
    ...artifact,
    digest: readExistingNpmIntegrity({ cwd, artifact }),
  }));
}
export function writeExistingNpmEvidence({
  evidencePath,
  version,
  channel,
  sourceSha,
  releaseSha,
  targetRef,
  releaseMaterialSha,
  publishToolingSha,
  artifacts,
}) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        schema: 1,
        version,
        channel,
        source_sha: sourceSha,
        release_sha: releaseSha,
        target_ref: targetRef,
        release_material_sha: releaseMaterialSha,
        publish_tooling_sha: publishToolingSha,
        artifacts,
      },
      null,
      2,
    )}\n`,
  );
}
