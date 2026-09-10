#!/usr/bin/env node
import os from "node:os";
import { writeGitHubOutputs } from "./github-output.mjs";
import { createS3ObjectClient } from "../artifact-relay/s3-client.js";
import { uploadRelayArtifacts, downloadRelayArtifacts, cleanupRelayArtifacts } from "../artifact-relay/transactions.js";
function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function splitLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveUploadGroups() {
  const groups = [
    {
      role: "payload",
      artifactName: env("BUILDCHAIN_ARTIFACT_RELAY_PAYLOAD_ARTIFACT_NAME"),
      paths: splitLines(env("BUILDCHAIN_ARTIFACT_RELAY_PAYLOAD_PATHS")),
      required: true,
    },
    {
      role: "manifest",
      artifactName: env("BUILDCHAIN_ARTIFACT_RELAY_MANIFEST_ARTIFACT_NAME"),
      paths: splitLines(env("BUILDCHAIN_ARTIFACT_RELAY_MANIFEST_PATHS")),
      required: true,
    },
    {
      role: "diagnostics",
      artifactName: env("BUILDCHAIN_ARTIFACT_RELAY_DIAGNOSTICS_ARTIFACT_NAME"),
      paths: splitLines(env("BUILDCHAIN_ARTIFACT_RELAY_DIAGNOSTICS_PATHS")),
      required: true,
    },
  ];
  const credentialInputPaths = splitLines(env("BUILDCHAIN_ARTIFACT_RELAY_CREDENTIAL_INPUT_PATHS"));
  if (credentialInputPaths.length > 0) {
    groups.push({
      role: "credential-input",
      artifactName: env("BUILDCHAIN_ARTIFACT_RELAY_CREDENTIAL_INPUT_ARTIFACT_NAME"),
      paths: credentialInputPaths,
      required: true,
    });
  }
  return groups;
}


const client = createS3ObjectClient({ credentials: { accessKeyId: env("AWS_ACCESS_KEY_ID"), secretAccessKey: env("AWS_SECRET_ACCESS_KEY"), sessionToken: env("AWS_SESSION_TOKEN") } });
try {
  const command = process.argv[2];
  const options = { client, inputRoot: env("BUILDCHAIN_ARTIFACT_RELAY_INPUT_ROOT", ".buildchain/downloaded-relay-manifests"), outputRoot: env("BUILDCHAIN_ARTIFACT_RELAY_OUTPUT_ROOT", ".buildchain/relayed-artifacts"), region: env("BUILDCHAIN_ARTIFACT_RELAY_REGION"), platformId: env("BUILDCHAIN_ARTIFACT_RELAY_PLATFORM_ID", os.platform()) };
  let result;
  if (command === "upload") result = await uploadRelayArtifacts({ ...options,
    workspace: env("BUILDCHAIN_ARTIFACT_RELAY_WORKSPACE", process.cwd()), manifestPath: env("BUILDCHAIN_ARTIFACT_RELAY_MANIFEST_PATH", ".buildchain/artifacts/relay-manifest.json"), bucket: env("BUILDCHAIN_ARTIFACT_RELAY_BUCKET"), prefix: env("BUILDCHAIN_ARTIFACT_RELAY_PREFIX", "buildchain-artifacts"), groups: resolveUploadGroups(), repository: env("GITHUB_REPOSITORY"), runId: env("GITHUB_RUN_ID"), runAttempt: env("GITHUB_RUN_ATTEMPT"), sourceSha: env("BUILDCHAIN_ARTIFACT_RELAY_SOURCE_SHA", env("GITHUB_SHA")), platformName: env("BUILDCHAIN_ARTIFACT_RELAY_PLATFORM_NAME", options.platformId) });
  else if (command === "download") result = await downloadRelayArtifacts(options);
  else if (command === "cleanup") result = await cleanupRelayArtifacts(options);
  else throw new Error("usage: artifact-relay-s3.mjs <upload|download|cleanup>");
  writeGitHubOutputs(result.outputs);
} catch (error) { console.error(`::error::${String(error.message).replaceAll("\n", "%0A")}`); process.exitCode = error.status || 1; }
