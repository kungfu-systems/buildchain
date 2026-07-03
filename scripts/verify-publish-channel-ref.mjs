#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  resolvePublishChannelTargetRef,
  verifyPublishChannelRef,
} from "./build-contract-core.mjs";
import {
  normalizeSourceRef,
  resolvePublishSourceRefSha,
} from "./publish-source-ref-resolver.mjs";

function readEnv(env, name, fallback = "") {
  return env[name] || fallback;
}

export async function verifyPublishChannelRefCli({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const sourceRef = normalizeSourceRef(readEnv(env, "BUILDCHAIN_PUBLISH_SOURCE_REF"));
  const sourceSha = readEnv(env, "BUILDCHAIN_PUBLISH_SOURCE_SHA");
  const targetRef = resolvePublishChannelTargetRef({
    sourceRef,
    targetRef: readEnv(env, "BUILDCHAIN_PUBLISH_TARGET_REF"),
  });
  if (!targetRef) {
    return verifyPublishChannelRef({ sourceRef, sourceSha, targetRef });
  }
  const repository = readEnv(env, "BUILDCHAIN_SOURCE_REPOSITORY", readEnv(env, "GITHUB_REPOSITORY"));
  const targetSha = readEnv(env, "BUILDCHAIN_CURRENT_TARGET_SHA")
    || await resolvePublishSourceRefSha({
      repository,
      sourceRef: targetRef,
      env,
      fetchImpl,
    });
  return verifyPublishChannelRef({
    sourceRef,
    sourceSha,
    targetRef,
    targetSha,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyPublishChannelRefCli();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
