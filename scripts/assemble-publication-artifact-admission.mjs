#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  createPublicationAdmission,
  createPublicationGateDecision,
  createRunnerProvenance,
  publicationGateAggregateBindings,
} from "../packages/core/publication-authority.js";
import { buildPublicationArtifactCandidate } from "./publication-artifact-candidate.mjs";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function sourceTree(repository, sourceSha, token) {
  const response = await fetch(
    `${required("GITHUB_API_URL")}/repos/${repository}/git/commits/${sourceSha}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok)
    throw new Error(
      `could not resolve admitted source tree: GitHub API ${response.status}`,
    );
  const commit = await response.json();
  return String(commit.tree?.sha || "").toLowerCase();
}

function writeBundle(outputDir, values) {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [name, value] of Object.entries(values)) {
    fs.writeFileSync(
      path.join(outputDir, `${name}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }
  if (process.env.GITHUB_OUTPUT) {
    const output = fs.createWriteStream(process.env.GITHUB_OUTPUT, {
      flags: "a",
    });
    for (const [name, value] of Object.entries(values)) {
      if (name === "candidate") continue;
      output.write(
        `${name.replaceAll("_", "-")}-json=${JSON.stringify(value)}\n`,
      );
    }
    output.end();
  }
}

async function main() {
  const repository = required("BUILDCHAIN_REPOSITORY");
  const sourceSha = required("BUILDCHAIN_SOURCE_SHA").toLowerCase();
  const runtimeRoot =
    process.env.BUILDCHAIN_RUNTIME_ROOT || ".buildchain/authority-runtime";
  const runtimeSha = execFileSync(
    "git",
    ["-C", runtimeRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  )
    .trim()
    .toLowerCase();
  const token = required("GITHUB_TOKEN");
  const treeSha = await sourceTree(repository, sourceSha, token);
  const candidateBundle = buildPublicationArtifactCandidate({
    artifactRoot:
      process.env.BUILDCHAIN_ARTIFACT_ROOT ||
      ".buildchain/publication-evidence/artifact",
    controllerRoot:
      process.env.BUILDCHAIN_CONTROLLER_ROOT ||
      ".buildchain/publication-evidence/controller",
    repository,
    sourceSha,
    sourceTreeSha: treeSha,
    runtimeSha,
  });
  const controllerReceipt = candidateBundle.evidence.controllerReceipt;
  const controlPlaneAudit = JSON.parse(
    fs.readFileSync(required("BUILDCHAIN_CONTROL_PLANE_AUDIT_PATH"), "utf8"),
  );
  const registry = JSON.parse(
    fs.readFileSync(
      path.join(runtimeRoot, "dist/site/publication-authority-registry.json"),
      "utf8",
    ),
  );
  const gateAggregate = createPublicationGateDecision({
    sourceSha,
    profile: process.env.BUILDCHAIN_GATE_PROFILE || "managed-paper-publication",
    required: false,
    rationale:
      process.env.BUILDCHAIN_GATE_RATIONALE ||
      "The managed paper repository declares no project-specific Shifu Gate registry.",
    policy: { scope: "managed-paper-publication", repository },
  });
  const runnerProvenance = createRunnerProvenance({
    runnerClass: "ephemeral",
    os: required("RUNNER_OS"),
    architecture: required("RUNNER_ARCH"),
    imageDigest: sha256(
      `${process.env.ImageOS || "unknown"}|${process.env.ImageVersion || "unknown"}`,
    ),
    measurementDigest: sha256(
      [
        process.env.GITHUB_WORKFLOW,
        process.env.GITHUB_JOB,
        process.env.GITHUB_RUN_ID,
        process.env.GITHUB_RUN_ATTEMPT,
        process.env.RUNNER_ENVIRONMENT,
      ].join("|"),
    ),
    isolation: "github-hosted-single-job",
  });
  const issuedAt = new Date();
  const gateBindings = publicationGateAggregateBindings(gateAggregate);
  const qualificationRequired = process.env.BUILDCHAIN_CONSUMER_QUALIFICATION_REQUIRED === "true";
  const admission = createPublicationAdmission({
    registryDigest: registry.registryDigest,
    workflowPath:
      process.env.BUILDCHAIN_AUTHORITY_WORKFLOW_PATH ||
      ".github/workflows/paper-release-sealed.yml",
    publisherWorkflowPath: required("BUILDCHAIN_PUBLISHER_WORKFLOW_PATH"),
    repository,
    sourceSha,
    runtimeSha,
    contractDigest: controllerReceipt.runtime?.contractDigest,
    policyDigest: gateAggregate.policyDigest,
    gateRegistryDigest: gateBindings.registryDigest,
    controllerReceiptDigest: controllerReceipt.digest,
    runnerProvenanceDigest: runnerProvenance.receiptDigest,
    controlPlaneAuditDigest: controlPlaneAudit.receiptDigest,
    gateAggregateDigest: gateAggregate.digest,
    environment: "none",
    product: required("BUILDCHAIN_PUBLICATION_PRODUCT"),
    target: required("BUILDCHAIN_PUBLICATION_TARGET"),
    version: required("BUILDCHAIN_PUBLICATION_VERSION"),
    channel: required("BUILDCHAIN_PUBLICATION_CHANNEL"),
    artifactDigest: candidateBundle.candidate.candidateDigest,
    nonce: `${required("GITHUB_RUN_ID")}:${required("GITHUB_RUN_ATTEMPT")}:${sourceSha}:paper`,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 10 * 60 * 1000).toISOString(),
    qualification: {
      required: qualificationRequired,
      predicateId: process.env.BUILDCHAIN_CONSUMER_PREDICATE_ID || "",
      predicateDigest: process.env.BUILDCHAIN_CONSUMER_PREDICATE_DIGEST || "",
    },
  });
  const bindingNames = [
    "repository",
    "publisherWorkflowPath",
    "sourceSha",
    "runtimeSha",
    "contractDigest",
    "policyDigest",
    "gateRegistryDigest",
    "controllerReceiptDigest",
    "gateAggregateDigest",
    "environment",
    "product",
    "target",
    "version",
    "channel",
    "artifactDigest",
  ];
  const expected = Object.fromEntries(
    bindingNames.map((name) => [name, admission[name]]),
  );
  writeBundle(
    process.env.BUILDCHAIN_OUTPUT_DIR ||
      ".buildchain/publication-authority/auto",
    {
      admission,
      runner_provenance: runnerProvenance,
      control_plane_audit: controlPlaneAudit,
      gate_aggregate: gateAggregate,
      expected,
      candidate: candidateBundle.candidate,
    },
  );
}

main().catch((error) => {
  console.error(`assemble publication artifact admission: ${error.message}`);
  process.exitCode = 1;
});
