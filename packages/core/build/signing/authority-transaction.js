import path from "node:path";
import { materializeArtifactSigningRequest } from "./materialize.js";
import { finalizeNativeArtifactSigningResult } from "./native-result.js";
import { mergeArtifactSigningResults } from "./merge-results.js";
import { verifyArtifactSigningResults } from "./verify-results.js";
import {
  signMacosPayload,
  signWindowsPayload,
} from "../../providers/signing/native.js";
export async function signNativeRequest(
  {
    requestRoot,
    requestPath,
    outputRoot,
    workRoot,
    runtimeRoot,
    profile,
    artifactId,
    credentials,
    environment,
    expectedRunId,
    expectedRunAttempt,
  },
  {
    materialize = materializeArtifactSigningRequest,
    macos = signMacosPayload,
    windows = signWindowsPayload,
    seal = finalizeNativeArtifactSigningResult,
  } = {},
) {
  const providers = {
      "apple-developer-id": macos,
      "windows-authenticode": windows,
    },
    provider = providers[profile];
  if (!provider) throw new Error("Unsupported native signing profile");
  const payload = path.join(
      workRoot,
      profile === "windows-authenticode"
        ? "signed-payload.exe"
        : "signed-payload",
    ),
    evidencePath = path.join(workRoot, "provider-evidence.json");
  const { request } = materialize({
    requestRoot,
    requestPath,
    expectedProfile: profile,
    outputPath: payload,
  });
  if (request.artifact.id !== artifactId)
    throw new Error(
      "Native signing request differs from its admitted artifact",
    );
  await provider({
    runtimeRoot,
    payload,
    evidencePath,
    artifact: request.artifact,
    signature: request.signature,
    credentials,
    environment,
  });
  return seal({
    requestRoot,
    requestPath,
    signedPayload: payload,
    evidencePath,
    outputRoot,
    expectedRunId,
    expectedRunAttempt,
  });
}
export function qualifySigningDelivery(
  { requestRoot, inputRoot, outputRoot },
  {
    merge = mergeArtifactSigningResults,
    verify = verifyArtifactSigningResults,
  } = {},
) {
  merge({ inputRoot, outputRoot });
  return verify({ requestRoot, resultRoot: outputRoot });
}
