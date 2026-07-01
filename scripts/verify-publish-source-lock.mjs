#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parsePublishSourceRef, verifyPublishSourceLock } from "./build-contract-core.mjs";
import { normalizeSourceRef, resolvePublishSourceRefSha } from "./publish-source-ref-resolver.mjs";

function readEnv(env, name, fallback = "") {
  return env[name] || fallback;
}

export async function verifyPublishSourceLockCli({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const sourceRef = normalizeSourceRef(readEnv(env, "BUILDCHAIN_PUBLISH_SOURCE_REF"));
  const parsed = parsePublishSourceRef(sourceRef);
  if (!parsed.enabled) {
    return { ok: true, sourceRef, skipped: true };
  }
  const repository = readEnv(env, "BUILDCHAIN_SOURCE_REPOSITORY", readEnv(env, "GITHUB_REPOSITORY"));
  const currentSha = readEnv(env, "BUILDCHAIN_CURRENT_SOURCE_SHA")
    || await resolvePublishSourceRefSha({ repository, sourceRef: parsed.sourceRef, env, fetchImpl });
  return verifyPublishSourceLock({
    sourceRef: parsed.sourceRef,
    expectedSha: readEnv(env, "BUILDCHAIN_PUBLISH_SOURCE_SHA"),
    currentSha,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyPublishSourceLockCli();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
