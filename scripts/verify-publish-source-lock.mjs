#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parsePublishSourceRef, verifyPublishSourceLock } from "./build-contract-core.mjs";

function readEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function lsRemoteHead(repository, sourceRef) {
  const token = readEnv("GITHUB_TOKEN");
  const args = [];
  if (token) {
    args.push("-c", `http.https://github.com/.extraheader=AUTHORIZATION: bearer ${token}`);
  }
  args.push("ls-remote", `https://github.com/${repository}.git`, `refs/heads/${sourceRef}`);
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

export function verifyPublishSourceLockCli() {
  const sourceRef = readEnv("BUILDCHAIN_PUBLISH_SOURCE_REF").replace(/^refs\/heads\//, "");
  const parsed = parsePublishSourceRef(sourceRef);
  if (!parsed.enabled) {
    return { ok: true, sourceRef, skipped: true };
  }
  const repository = readEnv("BUILDCHAIN_SOURCE_REPOSITORY", readEnv("GITHUB_REPOSITORY"));
  const currentSha = readEnv("BUILDCHAIN_CURRENT_SOURCE_SHA") || lsRemoteHead(repository, parsed.sourceRef);
  return verifyPublishSourceLock({
    sourceRef: parsed.sourceRef,
    expectedSha: readEnv("BUILDCHAIN_PUBLISH_SOURCE_SHA"),
    currentSha,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = verifyPublishSourceLockCli();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
