#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifactSigningRequest } from "../packages/core/artifact-signing.js";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function resolveBelow(root, relative, label) {
  const target = path.resolve(root, required(relative, label));
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${label} must resolve below its root`);
  return target;
}

function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

export function materializeArtifactSigningRequest({
  requestRoot = process.env.BUILDCHAIN_SIGNING_REQUEST_ROOT,
  requestPath = process.env.BUILDCHAIN_SIGNING_REQUEST_PATH,
  expectedProfile = process.env.BUILDCHAIN_SIGNING_EXPECTED_PROFILE,
  outputPath = process.env.BUILDCHAIN_UNSIGNED_OUTPUT,
} = {}) {
  const root = path.resolve(required(requestRoot, "signing request root"));
  const requestFile = resolveBelow(root, requestPath, "request path");
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  const check = validateArtifactSigningRequest(request);
  if (!check.ok) throw new Error(`invalid artifact signing request: ${check.issues.join(", ")}`);
  if (expectedProfile && request.signature.profile !== expectedProfile) throw new Error("artifact signing profile mismatch");
  if (request.artifact.transport?.format !== "exact-file") throw new Error("native executable signing requires exact-file transport");
  const requestIndexRoot = path.dirname(path.dirname(requestFile));
  const payload = resolveBelow(requestIndexRoot, request.artifact.transport.file, "transport payload");
  const stat = fs.statSync(payload);
  const payloadDigest = sha256File(payload);
  if (!stat.isFile() || stat.size !== request.artifact.transport.bytes || stat.size !== request.artifact.bytes || payloadDigest !== request.artifact.transport.digest || payloadDigest !== request.artifact.digest) {
    throw new Error("signing payload does not match its sealed request");
  }
  const output = path.resolve(required(outputPath, "unsigned output path"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(payload, output, fs.constants.COPYFILE_EXCL);
  writeGitHubOutputs({
    "artifact-id": request.artifact.id,
    "payload-path": output,
    "request-digest": request.digest,
    "signature-provider": request.signature.provider,
  });
  return { request, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    materializeArtifactSigningRequest();
  } catch (error) {
    console.error(`::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`);
    process.exitCode = 1;
  }
}
