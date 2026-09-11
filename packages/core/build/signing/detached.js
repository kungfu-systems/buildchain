import {
  required,
  safeSigningId,
  signingFilesNamed,
  signingFileDigest,
  resolveSigningPath,
  writeSigningResultIndex,
} from "./files.js";
import { decodeDetachedPrivateKey } from "../../providers/signing/detached-key.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createArtifactSigningReceipt,
  validateArtifactSigningRequest,
} from "../artifact-signing.js";
import {
  artifactSigningEvidenceDigest,
  createArtifactSigningResult,
} from "../artifact-signing-result.js";
import { signDetachedArtifactRequest } from "../detached-artifact-signature.js";

export function signDetachedArtifactRequests({
  inputRoot,
  outputRoot,
  privateKeyBase64,
  keyId,
  artifactId,
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
  const privateKey = decodeDetachedPrivateKey(privateKeyBase64);
  const results = [];
  for (const entry of index.requests || []) {
    const requestPath = resolveSigningPath(
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
    if (artifactId && request.artifact.id !== artifactId) continue;
    if (request.signature.profile !== "detached-signature-v1") continue;
    const transport = request.artifact.transport;
    if (transport?.format !== "exact-file") {
      throw new Error(
        "detached signing currently requires an exact-file transport",
      );
    }
    const payloadPath = resolveSigningPath(
      resolvedInput,
      transport.file,
      "signing payload path",
    );
    const bytes = fs.statSync(payloadPath).size;
    const digest = signingFileDigest(payloadPath);
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
    const envelopeText = `${JSON.stringify(signed.envelope, null, 2)}\n`;
    fs.writeFileSync(envelopePath, envelopeText);
    const evidence = [
      {
        kind: "ed25519-detached",
        path: "signature.json",
        digest: signingFileDigest(envelopePath),
      },
    ];
    const receipt = createArtifactSigningReceipt({
      request,
      authority: { runtimeSha: request.runtime.sha },
      result: {
        artifactDigest: request.artifact.digest,
        evidenceDigest: artifactSigningEvidenceDigest(evidence),
      },
      signatures: [
        {
          kind: "ed25519-detached",
          digest: signed.envelope.digest,
        },
      ],
    });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const payloadDirectory = path.join(resultDirectory, "payload");
    fs.mkdirSync(payloadDirectory, { recursive: true });
    const payloadOutputPath = path.join(
      payloadDirectory,
      path.basename(payloadPath),
    );
    fs.copyFileSync(payloadPath, payloadOutputPath, fs.constants.COPYFILE_EXCL);
    const result = createArtifactSigningResult({
      request,
      receipt,
      receiptPath: "receipt.json",
      payload: {
        path: `payload/${path.basename(payloadOutputPath)}`,
        bytes,
        digest,
      },
      evidence,
      verification: {
        status: "passed",
        provider: request.signature.provider,
        checks: ["sealed-payload-digest", "ed25519-signature-created"],
      },
    });
    const resultPath = path.join(resultDirectory, "result.json");
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    results.push({
      id: entry.id,
      requestDigest: request.digest,
      resultDigest: result.digest,
      result: path
        .relative(resolvedOutput, resultPath)
        .split(path.sep)
        .join("/"),
      payload: path
        .relative(resolvedOutput, payloadOutputPath)
        .split(path.sep)
        .join("/"),
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
  if (artifactId && results.length !== 1) {
    throw new Error(`expected one detached signing request for ${artifactId}`);
  }
  return writeSigningResultIndex(resolvedOutput, results);
}
