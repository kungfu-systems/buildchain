#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveArtifactTransfer } from "../artifact/transfer-policy.js";
function resolveArtifactTransferMode(env = process.env) {
  return resolveArtifactTransfer({ mode: env.INPUT_TRANSFER_MODE || "github-artifacts", relayRequired: env.INPUT_RELAY_REQUIRED !== "false",
    bucket: env.INPUT_S3_BUCKET || env.VAR_S3_BUCKET, region: env.INPUT_S3_REGION || env.VAR_S3_REGION,
    prefix: env.INPUT_S3_PREFIX || env.VAR_S3_PREFIX,
    uploadRole: env.INPUT_S3_UPLOAD_ROLE_ARN || env.VAR_S3_UPLOAD_ROLE_ARN || env.SECRET_S3_UPLOAD_ROLE_ARN,
    downloadRole: env.INPUT_S3_DOWNLOAD_ROLE_ARN || env.VAR_S3_DOWNLOAD_ROLE_ARN || env.SECRET_S3_DOWNLOAD_ROLE_ARN,
    oidcAudience: env.INPUT_OIDC_AUDIENCE || env.VAR_OIDC_AUDIENCE });
}

function writeArtifactTransferOutputs(outputPath, resolution) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.appendFileSync(
    outputPath,
    [
      `mode=${resolution.mode}`,
      `s3-bucket=${resolution.s3Bucket}`,
      `s3-region=${resolution.s3Region}`,
      `s3-prefix=${resolution.s3Prefix}`,
      `oidc-audience=${resolution.oidcAudience}`,
      "",
    ].join("\n"),
  );
}

function main() {
  const resolution = resolveArtifactTransferMode();
  writeArtifactTransferOutputs(process.env.GITHUB_OUTPUT, resolution);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

export { resolveArtifactTransferMode, writeArtifactTransferOutputs };
