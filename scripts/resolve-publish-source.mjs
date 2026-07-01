#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createResolvedReleaseManifest,
  parsePublishSourceRef,
  resolvePublishSourceLock,
  writeGitHubOutputs,
} from "./build-contract-core.mjs";
import {
  resolvePublishSourceRefSha,
  sourceRefFromEnv,
} from "./publish-source-ref-resolver.mjs";

function readArg(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return args[index + 1] || "";
}

function readEnv(env, name, fallback = "") {
  return env[name] || fallback;
}

export async function resolvePublishSourceCli({
  args = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const mode = readArg(args, "mode", readEnv(env, "BUILDCHAIN_PUBLISH_SOURCE_MODE", "lock"));
  const sourceRef = sourceRefFromEnv(env);
  const parsed = parsePublishSourceRef(sourceRef);
  const repository = readEnv(env, "BUILDCHAIN_SOURCE_REPOSITORY", readEnv(env, "GITHUB_REPOSITORY"));
  const sourceSha = readEnv(env, "BUILDCHAIN_PUBLISH_SOURCE_SHA")
    || (parsed.enabled
      ? await resolvePublishSourceRefSha({ repository, sourceRef: parsed.sourceRef, env, fetchImpl })
      : readEnv(env, "GITHUB_SHA"));
  const lock = resolvePublishSourceLock({
    publishSourceRef: parsed.sourceRef,
    publishSourceSha: sourceSha,
    fallbackRef: readEnv(env, "GITHUB_REF_NAME", readEnv(env, "GITHUB_REF")),
    fallbackSha: readEnv(env, "GITHUB_SHA"),
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
    const cwd = path.resolve(readEnv(env, "BUILDCHAIN_SOURCE_CWD", "."));
    const outputPath = path.resolve(
      readEnv(env, "BUILDCHAIN_RELEASE_MANIFEST", ".buildchain/artifacts/publish-source-manifest.json"),
    );
    const manifest = await createResolvedReleaseManifest({
      cwd,
      repository,
      sourceRef: lock.sourceLocked ? lock.sourceRef : "",
      sourceSha: lock.sourceSha,
      anchorRequestJson: readEnv(env, "BUILDCHAIN_PUBLISH_ANCHOR_REQUEST_JSON"),
      publishRegistry: readEnv(env, "BUILDCHAIN_PUBLISH_REGISTRY", "https://registry.npmjs.org/"),
      distTag: readEnv(env, "BUILDCHAIN_PUBLISH_DIST_TAG"),
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
