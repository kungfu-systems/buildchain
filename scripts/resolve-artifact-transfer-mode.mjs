#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VALID_MODES = new Set(["github-artifacts", "s3-to-github-artifacts"]);

function firstValue(...values) {
  return values.find((value) => String(value || "").trim()) || "";
}

function resolveArtifactTransferMode(env = process.env) {
  const mode = env.INPUT_TRANSFER_MODE || "github-artifacts";
  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `artifact-transfer-mode must be github-artifacts or s3-to-github-artifacts, got: ${mode}`,
    );
  }
  if (mode === "github-artifacts") {
    return {
      mode,
      s3Bucket: "",
      s3Region: "",
      s3Prefix: "",
      oidcAudience: "",
    };
  }
  if (env.INPUT_RELAY_REQUIRED === "false") {
    return {
      mode: "github-artifacts",
      s3Bucket: "",
      s3Region: "",
      s3Prefix: "",
      oidcAudience: "",
    };
  }
  const s3Bucket = firstValue(env.INPUT_S3_BUCKET, env.VAR_S3_BUCKET);
  const s3Region = firstValue(env.INPUT_S3_REGION, env.VAR_S3_REGION);
  const s3Prefix = firstValue(
    env.INPUT_S3_PREFIX,
    env.VAR_S3_PREFIX,
    "buildchain-artifacts",
  );
  const uploadRole = firstValue(
    env.INPUT_S3_UPLOAD_ROLE_ARN,
    env.VAR_S3_UPLOAD_ROLE_ARN,
    env.SECRET_S3_UPLOAD_ROLE_ARN,
    env.INPUT_S3_ROLE_ARN,
    env.VAR_S3_ROLE_ARN,
    env.SECRET_S3_ROLE_ARN,
  );
  const downloadRole = firstValue(
    env.INPUT_S3_DOWNLOAD_ROLE_ARN,
    env.VAR_S3_DOWNLOAD_ROLE_ARN,
    env.SECRET_S3_DOWNLOAD_ROLE_ARN,
    env.INPUT_S3_ROLE_ARN,
    env.VAR_S3_ROLE_ARN,
    env.SECRET_S3_ROLE_ARN,
  );
  if (!s3Bucket) {
    throw new Error(
      "artifact-transfer-mode=s3-to-github-artifacts requires artifact-relay-s3-bucket or BUILDCHAIN_ARTIFACT_RELAY_S3_BUCKET",
    );
  }
  if (!s3Region) {
    throw new Error(
      "artifact-transfer-mode=s3-to-github-artifacts requires artifact-relay-s3-region or BUILDCHAIN_ARTIFACT_RELAY_S3_REGION",
    );
  }
  if (!uploadRole) {
    throw new Error(
      "artifact-transfer-mode=s3-to-github-artifacts requires an upload role ARN input, variable, or secret",
    );
  }
  if (!downloadRole) {
    throw new Error(
      "artifact-transfer-mode=s3-to-github-artifacts requires a download role ARN input, variable, or secret",
    );
  }
  const oidcAudience = firstValue(
    env.INPUT_OIDC_AUDIENCE,
    env.VAR_OIDC_AUDIENCE,
    s3Region.startsWith("cn-") ? "sts.amazonaws.com.cn" : "sts.amazonaws.com",
  );
  return { mode, s3Bucket, s3Region, s3Prefix, oidcAudience };
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
