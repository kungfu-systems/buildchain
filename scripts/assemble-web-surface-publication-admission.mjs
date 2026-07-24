#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  createPublicationAdmission,
  createPublicationControlPlaneAudit,
  createPublicationGateDecision,
  createRunnerProvenance,
  publicationGateAggregateBindings,
  verifyPublicationAdmission,
} from "../packages/core/publication-authority.js";
import { createWebSurfacePublicationCandidate } from "../packages/core/web-surface-publication-candidate.js";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
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
  if (!response.ok) throw new Error(`could not resolve admitted source tree: GitHub API ${response.status}`);
  return String((await response.json()).tree?.sha || "").toLowerCase();
}

function auditFact(id, value) {
  return { id, status: "pass", digest: sha256(JSON.stringify(value)) };
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
    output.write(`capability-digest=${values.capability.capabilityDigest}\n`);
    output.end();
  }
}

async function main() {
  const repository = required("BUILDCHAIN_REPOSITORY");
  const sourceSha = required("BUILDCHAIN_SOURCE_SHA").toLowerCase();
  const runtimeRoot = process.env.BUILDCHAIN_RUNTIME_ROOT || ".buildchain/runtime";
  const runtimeSha = execFileSync("git", ["-C", runtimeRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim().toLowerCase();
  const planPath = required("BUILDCHAIN_WEB_SURFACE_PLAN_PATH");
  const plan = readJson(planPath);
  const controllerReceipt = readJson(required("BUILDCHAIN_CONTROLLER_RECEIPT_PATH"));
  const decision = JSON.parse(required("BUILDCHAIN_PRODUCTION_DECISION_JSON"));
  const token = required("GITHUB_TOKEN");
  const sourceTreeSha = await sourceTree(repository, sourceSha, token);
  const planFileDigest = sha256(fs.readFileSync(planPath));
  const candidate = createWebSurfacePublicationCandidate({
    repository,
    sourceSha,
    sourceTreeSha,
    runtimeSha,
    plan,
    planFileDigest,
    controllerReceipt,
    decision,
  });
  const environment = required("BUILDCHAIN_PUBLICATION_ENVIRONMENT");
  const roleArn = required("BUILDCHAIN_PRODUCTION_ROLE_ARN");
  if (!/^arn:[^:]+:iam::[0-9]{12}:role\/.+/.test(roleArn)) {
    throw new Error("BUILDCHAIN_PRODUCTION_ROLE_ARN must be an AWS IAM role ARN");
  }
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("managed web-surface publication requires an ephemeral GitHub-hosted Actions runner");
  }
  const workflowPath = ".github/workflows/.web-surface.yml";
  const publisherWorkflowPath = workflowPath;
  const issuedAt = new Date();
  const controlPlaneAudit = createPublicationControlPlaneAudit({
    repository,
    workflowPath,
    publisherWorkflowPath,
    environment,
    observedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 10 * 60 * 1000).toISOString(),
    facts: [
      auditFact("actions-policy", { githubActions: true, sourceSha }),
      auditFact("branch-policy", { decisionKind: decision.kind, decisionDigest: decision.decisionDigest }),
      auditFact("environment-policy", { environment }),
      auditFact("oidc-policy", { roleArnDigest: sha256(roleArn), authorization: "provider-at-transaction" }),
      auditFact("publisher-policy", { workflowPath, publisherWorkflowPath }),
      auditFact("runner-policy", { runnerEnvironment: process.env.RUNNER_ENVIRONMENT, runnerOs: process.env.RUNNER_OS }),
    ],
  });
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
  const gateAggregate = createPublicationGateDecision({
    sourceSha,
    profile: "managed-web-surface-production",
    required: false,
    rationale: "The managed web-surface production lane has no project-specific Shifu Gate registry.",
    policy: { scope: "managed-web-surface-production", repository },
  });
  const gateBindings = publicationGateAggregateBindings(gateAggregate);
  const registry = readJson(path.join(runtimeRoot, "dist/site/publication-authority-registry.json"));
  const target = `aws-role:${roleArn}#deploy:${candidate.deployTarget}`;
  const admission = createPublicationAdmission({
    registryDigest: registry.registryDigest,
    workflowPath,
    publisherWorkflowPath,
    repository,
    sourceSha,
    runtimeSha,
    contractDigest: controllerReceipt.runtime.contractDigest,
    policyDigest: gateBindings.policyDigest,
    gateRegistryDigest: gateBindings.registryDigest,
    controllerReceiptDigest: controllerReceipt.digest,
    runnerProvenanceDigest: runnerProvenance.receiptDigest,
    controlPlaneAuditDigest: controlPlaneAudit.receiptDigest,
    gateAggregateDigest: gateBindings.gateAggregateDigest,
    environment,
    product: candidate.site,
    target,
    version: sourceSha,
    channel: "production",
    artifactDigest: candidate.candidateDigest,
    nonce: `${required("GITHUB_RUN_ID")}:${required("GITHUB_RUN_ATTEMPT")}:${sourceSha}:web-production`,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 10 * 60 * 1000).toISOString(),
  });
  const bindingNames = [
    "repository", "publisherWorkflowPath", "sourceSha", "runtimeSha", "contractDigest", "policyDigest",
    "gateRegistryDigest", "controllerReceiptDigest", "gateAggregateDigest", "environment", "product",
    "target", "version", "channel", "artifactDigest",
  ];
  const expected = Object.fromEntries(bindingNames.map((name) => [name, admission[name]]));
  const capability = verifyPublicationAdmission({
    admission,
    registry,
    runnerProvenance,
    controlPlaneAudit,
    publicationEvidence: {
      webSurfaceCandidate: {
        repository,
        sourceSha,
        sourceTreeSha,
        runtimeSha,
        plan,
        planFileDigest,
        controllerReceipt,
        decision,
      },
      gateAggregate,
    },
    expected,
  });
  writeBundle(process.env.BUILDCHAIN_OUTPUT_DIR || ".buildchain/web-publication-authority", {
    admission,
    runner_provenance: runnerProvenance,
    control_plane_audit: controlPlaneAudit,
    gate_aggregate: gateAggregate,
    expected,
    candidate,
    capability,
  });
}

main().catch((error) => {
  console.error(`assemble web-surface publication admission: ${error.message}`);
  process.exitCode = 1;
});
