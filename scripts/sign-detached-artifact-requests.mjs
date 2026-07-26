#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifactSigningRequest } from "../packages/core/artifact-signing.js";
import { signDetachedArtifactRequest } from "../packages/core/detached-artifact-signature.js";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest("hex")}`;
}

function resolveInside(root, relative, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, required(relative, label));
  const rel = path.relative(resolvedRoot, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} must resolve below its declared root`);
  }
  return resolved;
}

function decodePrivateKey(value) {
  const compact = required(value, "detached signing private key").replace(
    /\s+/gu,
    "",
  );
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    throw new Error("detached signing private key must be canonical base64");
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.length < 32 || decoded.length > 16 * 1024) {
    throw new Error("detached signing private key has an invalid size");
  }
  return crypto.createPrivateKey({
    key: decoded,
    format: "der",
    type: "pkcs8",
  });
}

export function signDetachedArtifactRequests({
  inputRoot = process.env.BUILDCHAIN_SIGNING_REQUEST_ROOT,
  outputRoot = process.env.BUILDCHAIN_SIGNING_RESULT_ROOT,
  privateKeyBase64 = process.env.BUILDCHAIN_DETACHED_PRIVATE_KEY_PKCS8_BASE64,
  keyId = process.env.BUILDCHAIN_DETACHED_KEY_ID,
} = {}) {
  const resolvedInput = path.resolve(
    required(inputRoot, "signing request root"),
  );
  const resolvedOutput = path.resolve(
    required(outputRoot, "signing result root"),
  );
  fs.mkdirSync(resolvedOutput, { recursive: true });
  const index = JSON.parse(
    fs.readFileSync(path.join(resolvedInput, "index.json"), "utf8"),
  );
  if (
    index.contract !== "kungfu-buildchain-artifact-signing-request-index/v1"
  ) {
    throw new Error("artifact signing request index contract mismatch");
  }
  const privateKey = decodePrivateKey(privateKeyBase64);
  const results = [];
  for (const entry of index.requests || []) {
    const requestPath = resolveInside(
      resolvedInput,
      entry.path,
      "signing request path",
    );
    const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    const check = validateArtifactSigningRequest(request);
    if (!check.ok)
      throw new Error(
        `invalid artifact signing request: ${check.issues.join(", ")}`,
      );
    if (request.digest !== entry.digest)
      throw new Error("signing request index digest mismatch");
    if (request.signature.profile !== "detached-signature-v1") continue;
    const transport = request.artifact.transport;
    if (transport?.format !== "exact-file") {
      throw new Error(
        "detached signing currently requires an exact-file transport",
      );
    }
    const payloadPath = resolveInside(
      resolvedInput,
      transport.file,
      "signing payload path",
    );
    const bytes = fs.statSync(payloadPath).size;
    const digest = sha256File(payloadPath);
    if (
      bytes !== transport.bytes ||
      digest !== transport.digest ||
      bytes !== request.artifact.bytes ||
      digest !== request.artifact.digest
    ) {
      throw new Error(
        "detached signing payload does not match the sealed request",
      );
    }
    const signed = signDetachedArtifactRequest({ request, privateKey, keyId });
    const resultDirectory = path.join(
      resolvedOutput,
      path.basename(path.dirname(requestPath)),
    );
    fs.mkdirSync(resultDirectory, { recursive: true });
    const envelopePath = path.join(resultDirectory, "signature.json");
    const receiptPath = path.join(resultDirectory, "receipt.json");
    fs.writeFileSync(
      envelopePath,
      `${JSON.stringify(signed.envelope, null, 2)}\n`,
    );
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify(signed.receipt, null, 2)}\n`,
    );
    results.push({
      id: entry.id,
      requestDigest: request.digest,
      envelope: path
        .relative(resolvedOutput, envelopePath)
        .split(path.sep)
        .join("/"),
      receipt: path
        .relative(resolvedOutput, receiptPath)
        .split(path.sep)
        .join("/"),
    });
  }
  const resultIndex = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact-signing-result-index/v1",
    results,
  };
  const resultIndexPath = path.join(resolvedOutput, "index.json");
  fs.writeFileSync(
    resultIndexPath,
    `${JSON.stringify(resultIndex, null, 2)}\n`,
  );
  writeGitHubOutputs({
    "result-count": String(results.length),
    "result-index": resultIndexPath,
    "result-root": resolvedOutput,
  });
  return resultIndex;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    signDetachedArtifactRequests();
  } catch (error) {
    console.error(
      `::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`,
    );
    process.exitCode = 1;
  }
}
