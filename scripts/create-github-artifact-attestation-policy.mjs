#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  GITHUB_ARTIFACT_ATTESTATION_WORKFLOW,
  createGitHubArtifactAttestationPolicy,
  githubArtifactAttestationSha256File,
} from "../packages/core/github-artifact-attestation.js";

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function required(name) {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const cwd = path.resolve(env("BUILDCHAIN_SOURCE_CWD", "."));
const subjectRelativePath = required("BUILDCHAIN_GITHUB_ATTESTATION_SUBJECT_PATH").replace(/\\/g, "/");
const subjectPath = path.resolve(cwd, subjectRelativePath);
const manifestPath = path.resolve(required("BUILDCHAIN_GITHUB_ATTESTATION_PLATFORM_MANIFEST"));
const outputPath = path.resolve(required("BUILDCHAIN_GITHUB_ATTESTATION_POLICY_OUTPUT"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestEntry = (manifest.files || []).find((entry) => (
  String(entry.path || "").replace(/\\/g, "/") === subjectRelativePath
));
if (!manifestEntry) throw new Error(`platform manifest does not contain ${subjectRelativePath}`);
const digest = githubArtifactAttestationSha256File(subjectPath);
const size = fs.statSync(subjectPath).size;
if (`sha256:${String(manifestEntry.sha256 || "").toLowerCase()}` !== digest || Number(manifestEntry.size) !== size) {
  throw new Error("subject bytes do not match the final platform manifest");
}
const manifestDigest = githubArtifactAttestationSha256File(manifestPath);
const runtimeSha = required("BUILDCHAIN_RUNTIME_SHA").toLowerCase();
const signerSha = required("BUILDCHAIN_GITHUB_ATTESTATION_SIGNER_SHA").toLowerCase();
const policy = createGitHubArtifactAttestationPolicy({
  subject: { name: path.basename(subjectPath), path: subjectRelativePath, size, digest },
  caller: {
    repository: required("BUILDCHAIN_SOURCE_REPOSITORY"),
    sourceSha: required("BUILDCHAIN_SOURCE_SHA").toLowerCase(),
    sourceTreeSha: required("BUILDCHAIN_SOURCE_TREE_SHA").toLowerCase(),
  },
  signer: {
    repository: "kungfu-systems/buildchain",
    workflowPath: GITHUB_ARTIFACT_ATTESTATION_WORKFLOW,
    workflowDigest: signerSha,
  },
  build: {
    platform: required("BUILDCHAIN_PLATFORM_ID"),
    platformManifestDigest: manifestDigest,
    runnerReceiptRoot: manifestDigest,
    buildchainRuntimeSha: runtimeSha,
  },
});
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(policy, null, 2)}\n`);
process.stdout.write(`github-artifact-attestation-policy=${outputPath}\n`);
