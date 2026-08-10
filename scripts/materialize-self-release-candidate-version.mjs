#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getVersionStrategy,
  loadConfiguredAnchorManifest,
  discoverConfiguredDerivedVersionMaterial,
} from "../packages/core/buildchain-config.js";
import {
  alignMajorBootstrapReleaseImpact,
  currentConfiguredVersion,
  discoverVersionStateFiles,
  runVersionVerification,
  updateVersionStateContents,
  versionVerificationAllowedPathsForPromotion,
  versionVerificationEnv,
} from "../actions/promote-buildchain-ref/internal/version-state.js";

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    options[name] = value;
    index += 1;
  }
  return options;
}

export function materializeSelfReleaseCandidateVersion({
  cwd = process.cwd(),
  version,
  channel,
  sourceSha,
  generatedAt,
} = {}) {
  const resolvedVersion = required(version, "version");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(resolvedVersion)) {
    throw new Error(`version must be an exact semantic version: ${resolvedVersion}`);
  }
  const resolvedChannel = required(channel, "channel");
  if (!new Set(["alpha", "release", "major"]).has(resolvedChannel)) {
    throw new Error(`channel must be alpha, release, or major: ${resolvedChannel}`);
  }
  const resolvedSourceSha = required(sourceSha, "sourceSha");
  if (!/^[0-9a-f]{40}$/i.test(resolvedSourceSha)) {
    throw new Error("sourceSha must be a 40-character Git SHA");
  }
  const resolvedGeneratedAt = required(generatedAt, "generatedAt");
  if (Number.isNaN(Date.parse(resolvedGeneratedAt))) {
    throw new Error(`generatedAt must be an ISO timestamp: ${resolvedGeneratedAt}`);
  }

  const discovered = discoverVersionStateFiles(cwd);
  if (discovered.files.length === 0) {
    throw new Error("self-release candidate requires declared version state");
  }
  const discoveredPaths = discovered.files.map((file) => file.path);
  const derivedPaths = discoverConfiguredDerivedVersionMaterial(
    cwd,
    discovered.config,
  ).map((file) => file.path);
  const versionStrategy = getVersionStrategy(discovered.config);
  const anchorManifest = loadConfiguredAnchorManifest(cwd, discovered.config);
  const lifecycleEnv = versionVerificationEnv(versionStrategy, anchorManifest, {
    generatedAt: resolvedGeneratedAt,
    sourceSha: resolvedSourceSha,
  });
  if (resolvedChannel === "major") {
    lifecycleEnv.BUILDCHAIN_MAJOR_VERSION_BOOTSTRAP = "true";
  }

  let changedFiles = updateVersionStateContents(discovered.files, resolvedVersion);
  if (resolvedChannel === "major") {
    changedFiles = alignMajorBootstrapReleaseImpact(changedFiles, {
      version: resolvedVersion,
    });
  }
  const materializedFiles = runVersionVerification({
    cwd,
    loadedConfig: discovered.config,
    version: resolvedVersion,
    changedFiles,
    allowedPaths: versionVerificationAllowedPathsForPromotion(
      resolvedChannel,
      discoveredPaths,
      derivedPaths,
    ),
    env: lifecycleEnv,
    runLifecycleVerify: false,
  });
  const materialized = discoverVersionStateFiles(cwd);
  const actualVersion = currentConfiguredVersion(materialized.files);
  if (actualVersion !== resolvedVersion) {
    throw new Error(
      `materialized self-release candidate version mismatch: expected ${resolvedVersion}, got ${actualVersion || "<empty>"}`,
    );
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-self-release-candidate-version/v1",
    version: resolvedVersion,
    channel: resolvedChannel,
    sourceSha: resolvedSourceSha,
    generatedAt: resolvedGeneratedAt,
    files: materializedFiles.map((file) => file.path),
  };
}

export function materializeSelfReleaseCandidateVersionCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = materializeSelfReleaseCandidateVersion({
    cwd: path.resolve(options.cwd || process.cwd()),
    version: options.version,
    channel: options.channel,
    sourceSha: options["source-sha"],
    generatedAt: options["generated-at"],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  materializeSelfReleaseCandidateVersionCli();
}
