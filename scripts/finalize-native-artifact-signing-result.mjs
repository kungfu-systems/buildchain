#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createArtifactSigningReceipt,
  validateArtifactSigningRequest,
} from "../packages/core/artifact-signing.js";
import {
  artifactSigningEvidenceDigest,
  createArtifactSigningResult,
} from "../packages/core/artifact-signing-result.js";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function resolveBelow(root, relative, label) {
  const target = path.resolve(root, required(relative, label));
  const rel = path.relative(path.resolve(root), target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error(`${label} escapes its root`);
  return target;
}

export function finalizeNativeArtifactSigningResult({
  requestRoot = process.env.BUILDCHAIN_SIGNING_REQUEST_ROOT,
  requestPath = process.env.BUILDCHAIN_SIGNING_REQUEST_PATH,
  signedPayload = process.env.BUILDCHAIN_SIGNED_PAYLOAD,
  evidencePath = process.env.BUILDCHAIN_SIGNING_EVIDENCE,
  outputRoot = process.env.BUILDCHAIN_SIGNING_RESULT_ROOT,
  checks = process.env.BUILDCHAIN_SIGNING_VERIFICATION_CHECKS,
} = {}) {
  const requests = path.resolve(required(requestRoot, "signing request root"));
  const request = JSON.parse(
    fs.readFileSync(
      resolveBelow(requests, requestPath, "request path"),
      "utf8",
    ),
  );
  const requestCheck = validateArtifactSigningRequest(request);
  if (!requestCheck.ok)
    throw new Error(
      `invalid signing request: ${requestCheck.issues.join(", ")}`,
    );
  if (request.signature.semantics !== "native-platform-signature") {
    throw new Error(
      "native result finalizer rejects non-native signature profiles",
    );
  }
  const payloadSource = path.resolve(required(signedPayload, "signed payload"));
  const evidenceSource = path.resolve(
    required(evidencePath, "signing evidence"),
  );
  const resultDirectory = path.resolve(
    required(outputRoot, "signing result root"),
  );
  fs.mkdirSync(path.join(resultDirectory, "payload"), { recursive: true });
  const payloadPath = path.join(
    resultDirectory,
    "payload",
    path.basename(payloadSource),
  );
  fs.copyFileSync(payloadSource, payloadPath, fs.constants.COPYFILE_EXCL);
  const evidenceOutput = path.join(resultDirectory, "provider-evidence.json");
  fs.copyFileSync(evidenceSource, evidenceOutput, fs.constants.COPYFILE_EXCL);
  const evidenceDocument = JSON.parse(fs.readFileSync(evidenceOutput, "utf8"));
  if (
    evidenceDocument.status !== "passed" ||
    evidenceDocument.provider !== request.signature.provider
  ) {
    throw new Error(
      "provider evidence does not prove the requested native signature",
    );
  }
  const evidence = [
    {
      kind: `${request.signature.profile}-verification`,
      path: "provider-evidence.json",
      digest: sha256File(evidenceOutput),
    },
  ];
  const payloadDigest = sha256File(payloadPath);
  const receipt = createArtifactSigningReceipt({
    request,
    result: {
      artifactDigest: payloadDigest,
      evidenceDigest: artifactSigningEvidenceDigest(evidence),
    },
    signatures: [
      { kind: request.signature.profile, digest: evidence[0].digest },
    ],
  });
  fs.writeFileSync(
    path.join(resultDirectory, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  const verificationChecks = String(checks || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    verificationChecks.length === 0 &&
    Array.isArray(evidenceDocument.checks)
  ) {
    verificationChecks.push(
      ...evidenceDocument.checks
        .map((value) => String(value).trim())
        .filter(Boolean),
    );
  }
  if (verificationChecks.length === 0)
    throw new Error("provider evidence contains no verification checks");
  const result = createArtifactSigningResult({
    request,
    receipt,
    payload: {
      path: `payload/${path.basename(payloadPath)}`,
      bytes: fs.statSync(payloadPath).size,
      digest: payloadDigest,
    },
    evidence,
    verification: {
      status: "passed",
      provider: request.signature.provider,
      checks: verificationChecks,
    },
  });
  fs.writeFileSync(
    path.join(resultDirectory, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  const index = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact-signing-result-index/v1",
    results: [
      {
        id: request.artifact.id,
        requestDigest: request.digest,
        resultDigest: result.digest,
        result: "result.json",
        payload: result.artifact.path,
        receipt: "receipt.json",
      },
    ],
  };
  fs.writeFileSync(
    path.join(resultDirectory, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  writeGitHubOutputs({
    "result-root": resultDirectory,
    "result-index": path.join(resultDirectory, "index.json"),
  });
  return index;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    finalizeNativeArtifactSigningResult();
  } catch (error) {
    console.error(
      `::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`,
    );
    process.exitCode = 1;
  }
}
