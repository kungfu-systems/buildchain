#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  createPublicationAdmission,
  createPublicationArtifactManifestSet,
  createPublicationGateDecision,
  createRunnerProvenance,
} from "../packages/core/publication-authority.js";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function filesNamed(root, name) {
  const matches = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) matches.push(full);
    }
  }
  return matches.sort();
}

function oneJson(root, name) {
  const matches = filesNamed(root, name);
  if (matches.length !== 1) throw new Error(`expected exactly one ${name} under ${root}, found ${matches.length}`);
  return JSON.parse(fs.readFileSync(matches[0], "utf8"));
}

function payloadFor(manifest, root) {
  const artifactRoot = path.join(root, manifest.artifactName);
  if (!fs.existsSync(artifactRoot)) throw new Error(`candidate payload artifact is missing: ${manifest.artifactName}`);
  return {
    artifactName: manifest.artifactName,
    files: (manifest.files || []).filter((entry) => !entry.path.startsWith(".buildchain/")).map((entry) => {
      if (path.isAbsolute(entry.path) || entry.path.includes("\\") || entry.path.split("/").includes("..")) {
        throw new Error(`candidate payload manifest contains an unsafe path: ${entry.path}`);
      }
      const file = path.join(artifactRoot, entry.path);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error(`candidate payload file is missing: ${manifest.artifactName}/${entry.path}`);
      }
      return {
        path: entry.path,
        size: fs.statSync(file).size,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      };
    }),
  };
}

async function sourceTree(repository, sourceSha, token) {
  const response = await fetch(`${required("GITHUB_API_URL")}/repos/${repository}/git/commits/${sourceSha}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`could not resolve admitted source tree: GitHub API ${response.status}`);
  const commit = await response.json();
  return String(commit.tree?.sha || "");
}

function writeBundle(outputDir, values) {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [name, value] of Object.entries(values)) {
    fs.writeFileSync(path.join(outputDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    const output = fs.createWriteStream(process.env.GITHUB_OUTPUT, { flags: "a" });
    for (const [name, value] of Object.entries(values)) {
      output.write(`${name.replaceAll("_", "-")}-json=${JSON.stringify(value)}\n`);
    }
    output.end();
  }
}

async function main() {
  const evidenceRoot = process.env.BUILDCHAIN_EVIDENCE_ROOT || ".buildchain/publication-evidence";
  const runtimeRoot = process.env.BUILDCHAIN_RUNTIME_ROOT || ".buildchain/authority-runtime";
  const repository = required("BUILDCHAIN_REPOSITORY");
  const sourceSha = required("BUILDCHAIN_SOURCE_SHA").toLowerCase();
  const token = required("GITHUB_TOKEN");
  const passport = oneJson(path.join(evidenceRoot, "passport"), "release-candidate-passport.json");
  const controllerReceipt = oneJson(path.join(evidenceRoot, "controller"), "release-candidate-receipt.json");
  const controlPlaneAudit = JSON.parse(fs.readFileSync(required("BUILDCHAIN_CONTROL_PLANE_AUDIT_PATH"), "utf8"));
  const registry = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "dist/site/publication-authority-registry.json"), "utf8"));
  const runtimeSha = execFileSync("git", ["-C", runtimeRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
  const treeSha = await sourceTree(repository, sourceSha, token);
  if (!treeSha || treeSha !== passport.source?.treeHash) {
    throw new Error(`admitted source tree does not match release candidate: ${treeSha || "missing"}`);
  }

  const manifests = filesNamed(path.join(evidenceRoot, "manifests"), "manifest.json")
    .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  const artifactSet = createPublicationArtifactManifestSet({
    repository,
    sourceSha: passport.source?.headSha,
    sourceTreeSha: treeSha,
    manifests,
    payloads: manifests.map((manifest) => payloadFor(manifest, path.join(evidenceRoot, "payloads"))),
  });
  const suppliedGateAggregate = String(process.env.BUILDCHAIN_GATE_AGGREGATE_JSON || "").trim();
  let gateAggregate;
  if (suppliedGateAggregate) {
    gateAggregate = JSON.parse(suppliedGateAggregate);
  } else {
    if (process.env.BUILDCHAIN_ALLOW_NO_GATE !== "true") {
      throw new Error("managed release-candidate admission requires a Gate aggregate or explicit no-Gate decision");
    }
    gateAggregate = createPublicationGateDecision({
      sourceSha,
      profile: process.env.BUILDCHAIN_GATE_PROFILE || "managed-release-candidate-no-gate",
      required: false,
      rationale: process.env.BUILDCHAIN_GATE_RATIONALE || "The consumer explicitly declared no Shifu Gate registry for this publication transaction.",
      policy: { scope: "managed-release-candidate", repository },
    });
  }
  const runnerProvenance = createRunnerProvenance({
    runnerClass: "ephemeral",
    os: required("RUNNER_OS"),
    architecture: required("RUNNER_ARCH"),
    imageDigest: sha256(`${process.env.ImageOS || "unknown"}|${process.env.ImageVersion || "unknown"}`),
    measurementDigest: sha256([
      process.env.GITHUB_WORKFLOW,
      process.env.GITHUB_JOB,
      process.env.GITHUB_RUN_ID,
      process.env.GITHUB_RUN_ATTEMPT,
      process.env.RUNNER_ENVIRONMENT,
    ].join("|")),
    isolation: "github-hosted-single-job",
  });
  const packageJson = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"));
  const publicationVersion = required("BUILDCHAIN_PUBLICATION_VERSION");
  const issuedAt = new Date();
  const admission = createPublicationAdmission({
    registryDigest: registry.registryDigest,
    workflowPath: required("BUILDCHAIN_AUTHORITY_WORKFLOW_PATH"),
    publisherWorkflowPath: required("BUILDCHAIN_PUBLISHER_WORKFLOW_PATH"),
    repository,
    sourceSha,
    runtimeSha,
    contractDigest: controllerReceipt.runtime?.contractDigest,
    policyDigest: gateAggregate.policyDigest,
    controllerReceiptDigest: controllerReceipt.digest,
    runnerProvenanceDigest: runnerProvenance.receiptDigest,
    controlPlaneAuditDigest: controlPlaneAudit.receiptDigest,
    gateAggregateDigest: gateAggregate.digest,
    environment: process.env.BUILDCHAIN_PUBLICATION_ENVIRONMENT || "none",
    product: process.env.BUILDCHAIN_PUBLICATION_PRODUCT || "Buildchain",
    target: process.env.BUILDCHAIN_PUBLICATION_TARGET || `npm:${packageJson.name}`,
    version: publicationVersion,
    channel: required("BUILDCHAIN_PUBLICATION_CHANNEL"),
    artifactDigest: artifactSet.manifestSetDigest,
    nonce: `${required("GITHUB_RUN_ID")}:${required("GITHUB_RUN_ATTEMPT")}:${sourceSha}`,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 10 * 60 * 1000).toISOString(),
  });
  const bindingNames = [
    "repository", "publisherWorkflowPath", "sourceSha", "runtimeSha", "contractDigest", "policyDigest",
    "controllerReceiptDigest", "gateAggregateDigest", "environment", "product", "target", "version", "channel",
    "artifactDigest",
  ];
  const expected = Object.fromEntries(bindingNames.map((name) => [name, admission[name]]));
  writeBundle(process.env.BUILDCHAIN_OUTPUT_DIR || ".buildchain/publication-authority/auto", {
    admission,
    runner_provenance: runnerProvenance,
    control_plane_audit: controlPlaneAudit,
    gate_aggregate: gateAggregate,
    expected,
  });
}

main().catch((error) => {
  console.error(`assemble release-candidate admission: ${error.message}`);
  process.exitCode = 1;
});
