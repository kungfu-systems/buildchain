#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  validateControllerPlan,
  validateControllerReceipt,
} from "../packages/core/controller-evidence.js";
import {
  createPublicationAdmission,
  createPublicationGateDecision,
  createRunnerProvenance,
  publicationGateAggregateBindings,
} from "../packages/core/publication-authority.js";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function filesNamed(root, name) {
  const matches = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name === name) matches.push(full);
    }
  }
  return matches.sort();
}

function oneFile(root, name) {
  const matches = filesNamed(root, name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${name} under ${root}, found ${matches.length}`);
  }
  return matches[0];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeBundle(outputDir, values) {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [name, value] of Object.entries(values)) {
    fs.writeFileSync(path.join(outputDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
  if (!process.env.GITHUB_OUTPUT) return;
  const output = fs.createWriteStream(process.env.GITHUB_OUTPUT, { flags: "a" });
  for (const [name, value] of Object.entries(values)) {
    output.write(`${name.replaceAll("_", "-")}-json=${JSON.stringify(value)}\n`);
  }
  output.end();
}

function validateBundle(manifest, archivePath, { sourceSha, releaseTag }) {
  if (manifest?.contract !== "kungfu-buildchain-release-evidence-bundle") {
    throw new Error("binary release evidence bundle contract mismatch");
  }
  if (manifest.release?.tag !== releaseTag) throw new Error("binary release evidence tag mismatch");
  if (String(manifest.release?.sourceSha || "").toLowerCase() !== sourceSha) {
    throw new Error("binary release evidence source mismatch");
  }
  if (sha256File(archivePath) !== String(manifest.bundle?.sha256 || "").replace(/^sha256:/, "")) {
    throw new Error("binary release evidence archive digest mismatch");
  }
  const names = new Set((manifest.files || []).map((entry) => entry.bundlePath));
  for (const requiredPath of [
    "release-assets/buildchain-aarch64-apple-darwin.tar.gz",
    "release-assets/buildchain-x86_64-unknown-linux-gnu.tar.gz",
    "release-assets/buildchain-x86_64-pc-windows-msvc.zip",
    "release-assets/checksums.txt",
    "release-passport/buildchain.release.json",
  ]) {
    if (!names.has(requiredPath)) throw new Error(`binary release evidence is missing ${requiredPath}`);
  }
}

function main() {
  const evidenceRoot = process.env.BUILDCHAIN_EVIDENCE_ROOT || ".buildchain/publication-evidence";
  const runtimeRoot = process.env.BUILDCHAIN_RUNTIME_ROOT || ".buildchain/authority-runtime";
  const repository = required("BUILDCHAIN_REPOSITORY");
  const sourceSha = required("BUILDCHAIN_SOURCE_SHA").toLowerCase();
  const releaseTag = required("BUILDCHAIN_RELEASE_TAG");
  const version = required("BUILDCHAIN_PUBLICATION_VERSION");
  if (releaseTag !== `v${version}`) throw new Error("binary publication version and release tag mismatch");

  const passportRoot = path.join(evidenceRoot, "binary-passport");
  const controllerRoot = path.join(evidenceRoot, "binary-controller");
  const manifest = readJson(oneFile(passportRoot, "buildchain-release-bundle.json"));
  const archivePath = oneFile(passportRoot, "buildchain-release-bundle.tar.gz");
  const controllerPlan = readJson(oneFile(controllerRoot, "plan.json"));
  const controllerReceipt = readJson(oneFile(controllerRoot, "receipt.json"));
  validateBundle(manifest, archivePath, { sourceSha, releaseTag });

  const authorityRuntimeSha = execFileSync("git", ["-C", runtimeRoot, "rev-parse", "HEAD"], { encoding: "utf8" })
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(authorityRuntimeSha)) {
    throw new Error("publication authority runtime SHA is invalid");
  }
  const controllerPlanValidation = validateControllerPlan(controllerPlan);
  if (!controllerPlanValidation.ok || !controllerPlanValidation.qualifying) {
    throw new Error(`binary distribution controller plan did not qualify: ${controllerPlanValidation.issues.join("; ")}`);
  }
  const controllerValidation = validateControllerReceipt(controllerReceipt, {
    plan: controllerPlan,
    expectedSourceSha: sourceSha,
  });
  if (!controllerValidation.ok || !controllerValidation.qualifying) {
    throw new Error(`binary distribution controller receipt did not qualify: ${controllerValidation.issues.join("; ")}`);
  }
  if (controllerReceipt.controller?.id !== "binary-distribution") {
    throw new Error("binary distribution controller receipt has the wrong controller id");
  }
  const runtimeSha = controllerReceipt.runtime.sha;

  const controlPlaneAudit = readJson(required("BUILDCHAIN_CONTROL_PLANE_AUDIT_PATH"));
  const registry = readJson(path.join(runtimeRoot, "dist/site/publication-authority-registry.json"));
  const suppliedGate = String(process.env.BUILDCHAIN_GATE_AGGREGATE_JSON || "").trim();
  let gateAggregate;
  if (suppliedGate) {
    gateAggregate = JSON.parse(suppliedGate);
  } else {
    if (process.env.BUILDCHAIN_ALLOW_NO_GATE !== "true") {
      throw new Error("binary release admission requires a Gate aggregate or explicit no-Gate decision");
    }
    gateAggregate = createPublicationGateDecision({
      sourceSha,
      profile: "buildchain-binary-release-no-gate",
      required: false,
      rationale: "Buildchain standalone release assets carry provider-owned evidence and declare no consumer Shifu Gate registry.",
      policy: { scope: "binary-release-assets", repository },
    });
  }
  const gateBindings = publicationGateAggregateBindings(gateAggregate);
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
  const issuedAt = new Date();
  const admission = createPublicationAdmission({
    registryDigest: registry.registryDigest,
    workflowPath: required("BUILDCHAIN_AUTHORITY_WORKFLOW_PATH"),
    publisherWorkflowPath: required("BUILDCHAIN_PUBLISHER_WORKFLOW_PATH"),
    repository,
    sourceSha,
    runtimeSha,
    contractDigest: controllerReceipt.runtime?.contractDigest,
    policyDigest: gateBindings.policyDigest,
    gateRegistryDigest: gateBindings.registryDigest,
    controllerReceiptDigest: controllerReceipt.digest,
    runnerProvenanceDigest: runnerProvenance.receiptDigest,
    controlPlaneAuditDigest: controlPlaneAudit.receiptDigest,
    gateAggregateDigest: gateBindings.gateAggregateDigest,
    environment: "buildchain-release-assets",
    product: "Buildchain standalone binary",
    target: `github-release:${repository}@${releaseTag}`,
    version,
    channel: "release-assets",
    artifactDigest: manifest.bundle.sha256,
    nonce: `${required("GITHUB_RUN_ID")}:${required("GITHUB_RUN_ATTEMPT")}:${sourceSha}:binary-release-assets`,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 10 * 60 * 1000).toISOString(),
    qualification: { required: false, predicateId: "", predicateDigest: "" },
  });
  const expectedKeys = [
    "repository", "publisherWorkflowPath", "sourceSha", "runtimeSha", "contractDigest", "policyDigest",
    "gateRegistryDigest", "controllerReceiptDigest", "gateAggregateDigest", "environment", "product", "target",
    "version", "channel", "artifactDigest",
  ];
  const expected = Object.fromEntries(expectedKeys.map((name) => [name, admission[name]]));
  writeBundle(process.env.BUILDCHAIN_OUTPUT_DIR || ".buildchain/publication-authority/auto", {
    admission,
    runner_provenance: runnerProvenance,
    control_plane_audit: controlPlaneAudit,
    gate_aggregate: gateAggregate,
    expected,
  });
}

try {
  main();
} catch (error) {
  console.error(`assemble binary release admission: ${error.message}`);
  process.exitCode = 1;
}
