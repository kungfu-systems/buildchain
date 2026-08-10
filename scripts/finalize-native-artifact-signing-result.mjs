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
import { acceptedMacosCredentialEvidence } from "../actions/macos-credential-island/dmg-assembly.js";
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

function expectedCredentialExecution(
  appBundleResult,
  expectedRunId,
  expectedRunAttempt,
) {
  if (!appBundleResult) return null;
  return {
    runId: required(expectedRunId, "credential execution run id"),
    runAttempt: required(
      expectedRunAttempt,
      "credential execution run attempt",
    ),
  };
}

function acceptedProviderEvidence(evidence, request, expectedExecution) {
  return expectedExecution
    ? acceptedMacosCredentialEvidence(evidence, request, expectedExecution)
    : evidence.status === "passed" &&
        evidence.provider === request.signature.provider;
}

export function finalizeNativeArtifactSigningResult({
  requestRoot = process.env.BUILDCHAIN_SIGNING_REQUEST_ROOT,
  requestPath = process.env.BUILDCHAIN_SIGNING_REQUEST_PATH,
  signedPayload = process.env.BUILDCHAIN_SIGNED_PAYLOAD,
  evidencePath = process.env.BUILDCHAIN_SIGNING_EVIDENCE,
  credentialArtifactRoot = process.env
    .BUILDCHAIN_SIGNING_CREDENTIAL_ARTIFACT_ROOT,
  outputRoot = process.env.BUILDCHAIN_SIGNING_RESULT_ROOT,
  checks = process.env.BUILDCHAIN_SIGNING_VERIFICATION_CHECKS,
  expectedRunId = process.env.GITHUB_RUN_ID,
  expectedRunAttempt = process.env.GITHUB_RUN_ATTEMPT,
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
  const appBundleResult = request.artifact.kind === "app-bundle";
  const expectedExecution = expectedCredentialExecution(
    appBundleResult,
    expectedRunId,
    expectedRunAttempt,
  );
  const providerEvidencePassed = acceptedProviderEvidence(
    evidenceDocument,
    request,
    expectedExecution,
  );
  if (!providerEvidencePassed) {
    throw new Error(
      "provider evidence does not prove the requested native signature",
    );
  }
  let credentialOutput = "";
  let credentialEvidence = [];
  if (appBundleResult) {
    const credentialSource = path.resolve(
      required(
        credentialArtifactRoot,
        "credential artifact root for app-bundle result",
      ),
    );
    const credentialManifest = path.join(credentialSource, "manifest.json");
    if (!fs.statSync(credentialManifest).isFile())
      throw new Error("credential artifact manifest is missing");
    credentialOutput = path.join(resultDirectory, "credential-artifact");
    fs.cpSync(credentialSource, credentialOutput, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const manifestOutput = path.join(credentialOutput, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestOutput, "utf8"));
    if (!Array.isArray(manifest.files) || manifest.files.length === 0)
      throw new Error("credential artifact manifest contains no files");
    credentialEvidence = [
      {
        kind: "credential-artifact-manifest",
        path: "credential-artifact/manifest.json",
        digest: sha256File(manifestOutput),
      },
      ...manifest.files.map((file, index) => {
        const filePath = resolveBelow(
          credentialOutput,
          file.path,
          `credential artifact file ${index}`,
        );
        const observed = sha256File(filePath);
        if (observed !== `sha256:${String(file.sha256 || "").toLowerCase()}`)
          throw new Error(
            `credential artifact file digest mismatch: ${file.path}`,
          );
        return {
          kind: `credential-artifact-${index}`,
          path: `credential-artifact/${String(file.path).replaceAll("\\", "/")}`,
          digest: observed,
        };
      }),
    ];
  }
  const evidence = [
    {
      kind: `${request.signature.profile}-verification`,
      path: "provider-evidence.json",
      digest: sha256File(evidenceOutput),
    },
    ...credentialEvidence,
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
  if (verificationChecks.length === 0 && appBundleResult) {
    verificationChecks.push(
      ...Object.entries(evidenceDocument.verification || {})
        .filter(([, passed]) => passed === true)
        .map(([name]) => name),
      "application-notarytool-accepted",
      "disk-image-notarytool-accepted",
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
    "credential-artifact-root": credentialOutput,
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
