import * as core from "@actions/core";
import fs from "node:fs";
import path from "node:path";
import {
  createGitHubArtifactAttestationEvidence,
  prepareGitHubArtifactAttestation,
} from "../../packages/core/github-artifact-attestation.js";

function input(name, required = false) {
  return core.getInput(name, { required }).trim();
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function workflowEvidence() {
  const repository = process.env.GITHUB_REPOSITORY || "";
  const runId = process.env.GITHUB_RUN_ID || "";
  return {
    repository,
    runId,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
    job: process.env.GITHUB_JOB || "",
    url: `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repository}/actions/runs/${runId}`,
  };
}

async function main() {
  const mode = input("mode", true);
  const outputDir = path.resolve(input("output-dir") || ".buildchain/github-artifact-attestation");
  if (mode === "prepare") {
    const preparation = prepareGitHubArtifactAttestation({
      subjectPath: input("subject-path", true),
      platformManifestPath: input("platform-manifest-path", true),
      releasePassportPath: input("release-passport-path", true),
      policy: parseJson(input("policy-json", true), "policy-json"),
      expectedBuildchainRef: input("expected-buildchain-ref", true),
      expectedCallerRepository: input("expected-caller-repository", true),
      expectedSourceSha: input("expected-source-sha", true),
    });
    const predicatePath = path.join(outputDir, "predicate.json");
    const preparationPath = path.join(outputDir, "preparation.json");
    writeJson(predicatePath, preparation.predicate);
    writeJson(preparationPath, preparation);
    core.setOutput("subject-name", preparation.policy.subject.name);
    core.setOutput("subject-path", preparation.subjectPath);
    core.setOutput("subject-digest", preparation.policy.subject.digest);
    core.setOutput("predicate-type", preparation.predicateType);
    core.setOutput("predicate-path", predicatePath);
    core.setOutput("preparation-path", preparationPath);
    core.setOutput("preparation-json", JSON.stringify(preparation));
    return;
  }
  if (mode === "finalize") {
    const stagedBundlePath = path.join(outputDir, "sigstore-bundle.json");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(input("bundle-path", true), stagedBundlePath);
    const evidence = createGitHubArtifactAttestationEvidence({
      preparation: parseJson(input("preparation-json", true), "preparation-json"),
      attestationId: input("attestation-id", true),
      attestationUrl: input("attestation-url", true),
      bundlePath: stagedBundlePath,
      workflow: workflowEvidence(),
    });
    const evidencePath = path.join(outputDir, "github-artifact-attestation-evidence.json");
    writeJson(evidencePath, evidence);
    core.setOutput("evidence-path", evidencePath);
    core.setOutput("evidence-root", evidence.evidenceRoot);
    core.setOutput("bundle-digest", evidence.attestation.bundle.digest);
    core.setOutput("bundle-path", stagedBundlePath);
    return;
  }
  throw new Error("mode must be prepare or finalize");
}

main().catch((error) => core.setFailed(error.message));
