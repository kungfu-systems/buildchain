#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";

import { publicationAuthorityDigest } from "../packages/core/publication-authority.js";
import { webSurfacePublicationDigest } from "../packages/core/web-surface-publication-candidate.js";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main() {
  const capability = JSON.parse(required("BUILDCHAIN_PUBLICATION_CAPABILITY_JSON"));
  const { capabilityDigest, ...payload } = capability;
  if (publicationAuthorityDigest(payload) !== capabilityDigest) {
    throw new Error("web-surface publication capability digest mismatch");
  }
  if (capability.decision !== "allow" || Date.parse(capability.expiresAt) <= Date.now()) {
    throw new Error("web-surface publication capability is not live and authorizing");
  }
  const candidate = JSON.parse(required("BUILDCHAIN_WEB_SURFACE_CANDIDATE_JSON"));
  const { candidateDigest, ...candidatePayload } = candidate;
  if (
    webSurfacePublicationDigest(candidatePayload) !== candidateDigest ||
    candidateDigest !== capability.artifactDigest
  ) {
    throw new Error("web-surface publication candidate capability binding mismatch");
  }
  const plan = JSON.parse(fs.readFileSync(required("BUILDCHAIN_WEB_SURFACE_PLAN_PATH"), "utf8"));
  const planDigest = crypto
    .createHash("sha256")
    .update(`${JSON.stringify(plan, null, 2)}\n`)
    .digest("hex");
  if (
    candidate.planDigest !== planDigest ||
    candidate.artifactHash !== plan.artifact?.hash ||
    candidate.deployTarget !== plan.manifest?.deployTarget
  ) {
    throw new Error("web-surface publication candidate plan binding mismatch");
  }
  const roleArn = required("BUILDCHAIN_PRODUCTION_ROLE_ARN");
  const exact = {
    workflowPath: ".github/workflows/.web-surface.yml",
    repository: required("BUILDCHAIN_REPOSITORY"),
    sourceSha: required("BUILDCHAIN_SOURCE_SHA").toLowerCase(),
    runtimeSha: required("BUILDCHAIN_RUNTIME_SHA").toLowerCase(),
    environment: required("BUILDCHAIN_PUBLICATION_ENVIRONMENT"),
    product: String(plan.manifest?.site || ""),
    target: `aws-role:${roleArn}#deploy:${String(plan.manifest?.deployTarget || "")}`,
    version: required("BUILDCHAIN_SOURCE_SHA").toLowerCase(),
    channel: "production",
  };
  for (const [name, value] of Object.entries(exact)) {
    if (capability[name] !== value) throw new Error(`web-surface publication capability ${name} binding mismatch`);
  }
  for (const [name, value] of Object.entries({
    repository: exact.repository,
    sourceSha: exact.sourceSha,
    runtimeSha: exact.runtimeSha,
    site: exact.product,
    environment: exact.environment,
  })) {
    if (candidate[name] !== value) throw new Error(`web-surface publication candidate ${name} binding mismatch`);
  }
  if (capability.capabilityIds?.includes("web-production") !== true) {
    throw new Error("web-surface publication capability lacks web-production authority");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, capabilityDigest })}\n`);
}

try {
  main();
} catch (error) {
  console.error(`verify web-surface publication capability: ${error.message}`);
  process.exitCode = 1;
}
