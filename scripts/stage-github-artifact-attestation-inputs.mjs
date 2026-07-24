#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { stageGitHubArtifactAttestationInputs } from "../packages/core/github-artifact-attestation.js";

function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${key || "<end>"}`);
    }
    values[key.slice(2)] = value;
  }
  return values;
}

function splitPaths(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readPolicy(value) {
  const candidate = path.resolve(String(value || ""));
  return fs.existsSync(candidate)
    ? JSON.parse(fs.readFileSync(candidate, "utf8"))
    : JSON.parse(String(value || ""));
}

function appendOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  fs.appendFileSync(output, `${name}=${String(value)}\n`);
}

const options = args(process.argv.slice(2));
const result = stageGitHubArtifactAttestationInputs({
  policy: readPolicy(options.policy),
  subjectRoots: splitPaths(options["subject-roots"]),
  platformManifestPaths: splitPaths(options["platform-manifests"]),
  releasePassportPath: options["release-passport"],
  outputDir: options["output-dir"],
});
appendOutput("input-dir", result.outputDir);
appendOutput("policy-json", result.policyJson);
appendOutput("subject-relative-path", result.relativePaths.subject);
appendOutput("platform-manifest-relative-path", result.relativePaths.platformManifest);
appendOutput("release-passport-relative-path", result.relativePaths.releasePassport);
appendOutput("source-sha", result.policy.caller.sourceSha);
appendOutput("signer-sha", result.policy.signer.workflowDigest);
appendOutput("buildchain-runtime-sha", result.policy.build.buildchainRuntimeSha);
appendOutput("subject-name", result.policy.subject.name);
process.stdout.write(`${JSON.stringify({
  contract: result.contract,
  subject: result.policy.subject,
  caller: result.policy.caller,
  signer: result.policy.signer,
  paths: result.relativePaths,
}, null, 2)}\n`);
