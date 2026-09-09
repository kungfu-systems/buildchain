import fs from "node:fs";
import os from "node:os";
import { getBumpKeyword, normalizeRef, readCurrentVersion } from "./release-line-policy.mjs";

function readEnv(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    console.log(`${name}=${value}`);
    return;
  }
  fs.appendFileSync(outputPath, `${name}=${value}${os.EOL}`);
}

const cwd = readEnv("BUILDCHAIN_SOURCE_CWD", process.cwd());
const headRef = readEnv("BUILDCHAIN_HEAD_REF", process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME);
const baseRef = readEnv("BUILDCHAIN_BASE_REF", process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME);

if (!headRef || !baseRef) {
  throw new Error("BUILDCHAIN_HEAD_REF/GITHUB_HEAD_REF and BUILDCHAIN_BASE_REF/GITHUB_BASE_REF are required");
}

const keyword = getBumpKeyword({ cwd, headRef, baseRef });
const version = readCurrentVersion(cwd);

writeOutput("keyword", keyword);
writeOutput("version", version.version);
writeOutput("head-ref", normalizeRef(headRef));
writeOutput("base-ref", normalizeRef(baseRef));

console.log(`release PR verified: ${normalizeRef(headRef)} -> ${normalizeRef(baseRef)} (${keyword}, ${version.version})`);
