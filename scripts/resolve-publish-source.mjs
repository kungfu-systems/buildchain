#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createResolvedReleaseManifest,
  parsePublishSourceRef,
  resolvePublishSourceLock,
  writeGitHubOutputs,
} from "./build-contract-core.mjs";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || "";
}

function readEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function normalizeSourceRef(value, fallback = "") {
  return String(value || fallback || "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/tags\//, "");
}

function sourceRefFromEnv() {
  const configured = normalizeSourceRef(readEnv("BUILDCHAIN_PUBLISH_SOURCE_REF"));
  if (configured) {
    return configured;
  }
  const refName = normalizeSourceRef(readEnv("GITHUB_REF_NAME"));
  if (refName.startsWith("publish-gate/") || refName === "major-gate") {
    return refName;
  }
  return "";
}

function lsRemoteHead(repository, sourceRef) {
  const token = readEnv("GITHUB_TOKEN");
  const url = `https://github.com/${repository}.git`;
  const args = [];
  if (token) {
    args.push("-c", `http.https://github.com/.extraheader=AUTHORIZATION: bearer ${token}`);
  }
  args.push("ls-remote", url, `refs/heads/${sourceRef}`);
  const output = execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const [sha] = output.split(/\s+/);
  if (!sha) {
    throw new Error(`publish source ref not found: ${sourceRef}`);
  }
  return sha;
}

export async function resolvePublishSourceCli() {
  const mode = readArg("mode", readEnv("BUILDCHAIN_PUBLISH_SOURCE_MODE", "lock"));
  const sourceRef = sourceRefFromEnv();
  const parsed = parsePublishSourceRef(sourceRef);
  const repository = readEnv("BUILDCHAIN_SOURCE_REPOSITORY", readEnv("GITHUB_REPOSITORY"));
  const sourceSha = readEnv("BUILDCHAIN_PUBLISH_SOURCE_SHA")
    || (parsed.enabled ? lsRemoteHead(repository, parsed.sourceRef) : readEnv("GITHUB_SHA"));
  const lock = resolvePublishSourceLock({
    publishSourceRef: parsed.sourceRef,
    publishSourceSha: sourceSha,
    fallbackRef: readEnv("GITHUB_REF_NAME", readEnv("GITHUB_REF")),
    fallbackSha: readEnv("GITHUB_SHA"),
  });

  if (mode === "lock") {
    writeGitHubOutputs({
      "publish-source-ref": lock.sourceRef,
      "publish-source-full-ref": lock.fullRef,
      "publish-source-sha": lock.sourceSha,
      "publish-source-locked": String(lock.sourceLocked),
      "publish-source-channel": lock.channel,
      "publish-source-line": lock.line,
      "publish-source-consumer-version": lock.consumerVersion,
      "publish-source-reason": lock.sourceReason,
    });
    return lock;
  }
  if (mode === "manifest") {
    const cwd = path.resolve(readEnv("BUILDCHAIN_SOURCE_CWD", "."));
    const outputPath = path.resolve(
      readEnv("BUILDCHAIN_RELEASE_MANIFEST", ".buildchain/artifacts/publish-source-manifest.json"),
    );
    const manifest = await createResolvedReleaseManifest({
      cwd,
      repository,
      sourceRef: lock.sourceLocked ? lock.sourceRef : "",
      sourceSha: lock.sourceSha,
      anchorRequestJson: readEnv("BUILDCHAIN_PUBLISH_ANCHOR_REQUEST_JSON"),
      publishRegistry: readEnv("BUILDCHAIN_PUBLISH_REGISTRY", "https://registry.npmjs.org/"),
      distTag: readEnv("BUILDCHAIN_PUBLISH_DIST_TAG"),
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeGitHubOutputs({
      "publish-source-ref": lock.sourceRef,
      "publish-source-sha": lock.sourceSha,
      "publish-source-locked": String(lock.sourceLocked),
      "publish-source-channel": lock.channel,
      "publish-source-line": lock.line,
      "publish-source-consumer-version": lock.consumerVersion,
      "release-manifest-path": path.relative(process.cwd(), outputPath).split(path.sep).join("/"),
      "release-manifest-json": JSON.stringify(manifest),
    });
    return manifest;
  }
  throw new Error(`unsupported publish source mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await resolvePublishSourceCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
