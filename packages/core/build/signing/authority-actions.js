import fs from "node:fs";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { inspectArtifactSigningRequests } from "./intake.js";
import { signDetachedArtifactRequests } from "./detached.js";
import { finalizeNativeArtifactSigningResult } from "./native-result.js";
import {
  signNativeRequest,
  qualifySigningDelivery,
} from "./authority-transaction.js";
import { safeSigningId } from "./files.js";
const get = (core, name) => core.getInput(name, { required: true });
function context(core, env, needsItem = false) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE),
    runtimeRoot = installationRoot(import.meta.url);


  const request = JSON.parse(get(core, "request-json")),
    item = needsItem ? JSON.parse(get(core, "item-json")) : undefined;
  if (item && item.slug !== safeSigningId(item.id))
    throw new Error(
      "Signing matrix slug differs from its sealed artifact identifier",
    );
  return {
    workspace,
    runtimeRoot,
    request,
    item,
    requestRoot: path.join(workspace, ".buildchain/authority-intake"),
    ...(item
      ? {
          outputRoot: path.join(
            workspace,
            ".buildchain/provider-results",
            item.slug,
          ),
          workRoot: path.join(workspace, ".buildchain/native-work", item.slug),
        }
      : {}),
  };
}
export function admitSigningRequestsAction(core, env) {
  const { requestRoot, request } = context(core, env);
  const matrices = inspectArtifactSigningRequests({
    inputRoot: requestRoot,
    expectedRepository: request["source-repository"],
    expectedRequestRoot: request["expected-request-root"],
  });
  for (const [key, value] of Object.entries(matrices))
    core.setOutput(`${key}-matrix`, JSON.stringify(value));
  core.setOutput(
    "request-count",
    String(
      Object.values(matrices).reduce(
        (count, entries) => count + entries.length,
        0,
      ),
    ),
  );
}
export function signDetachedRequestsAction(core, env) {
  const { requestRoot, outputRoot, item } = context(core, env, true);
  if (
    typeof item.indexRoot !== "string" ||
    path.isAbsolute(item.indexRoot) ||
    item.indexRoot.split(/[\\/]/).includes("..")
  )
    throw new Error("Detached request index escapes authority intake");
  return signDetachedArtifactRequests({
    inputRoot: path.join(requestRoot, item.indexRoot),
    outputRoot,
    artifactId: item.id,
    privateKeyBase64: get(core, "private-key-base64"),
    keyId: get(core, "key-id"),
  });
}
function nativeInput(core, env, profile) {
  const input = context(core, env, true);
  return {
    ...input,
    requestPath: input.item.request,
    artifactId: input.item.id,
    profile,
    environment: env,
    expectedRunId: env.GITHUB_RUN_ID,
    expectedRunAttempt: env.GITHUB_RUN_ATTEMPT,
  };
}
export async function signMacosRequestAction(core, env) {
  if (process.platform !== "darwin")
    throw new Error("Apple signing requires a macOS runner");
  return signNativeRequest({
    ...nativeInput(core, env, "apple-developer-id"),
    credentials: {
      certificateBase64: get(core, "certificate-base64"),
      certificatePassword: get(core, "certificate-password"),
      certificateSha1: get(core, "certificate-sha1"),
      teamId: get(core, "team-id"),
      notaryKeyBase64: get(core, "notary-key-base64"),
      notaryKeyId: get(core, "notary-key-id"),
      notaryIssuer: get(core, "notary-issuer"),
    },
  });
}
export async function signWindowsRequestAction(core, env) {
  if (process.platform !== "win32")
    throw new Error("Authenticode signing requires a Windows runner");
  return signNativeRequest({
    ...nativeInput(core, env, "windows-authenticode"),
    credentials: {
      certificateBase64: get(core, "certificate-base64"),
      certificatePassword: get(core, "certificate-password"),
      certificateSha1: get(core, "certificate-sha1"),
      timestampUrl: get(core, "timestamp-url"),
    },
  });
}
export function sealNativeResultAction(core, env) {
  const { requestRoot, outputRoot, item } = context(core, env, true);
  return finalizeNativeArtifactSigningResult({
    requestRoot,
    requestPath: item.request,
    outputRoot,
    signedPayload: get(core, "signed-payload"),
    evidencePath: get(core, "evidence-path"),
    credentialArtifactRoot: get(core, "credential-artifact-root"),
    expectedRunId: env.GITHUB_RUN_ID,
    expectedRunAttempt: env.GITHUB_RUN_ATTEMPT,
  });
}
export function qualifySigningDeliveryAction(core, env) {
  const { workspace, requestRoot } = context(core, env);
  return qualifySigningDelivery({
    requestRoot,
    inputRoot: path.join(workspace, ".buildchain/provider-results"),
    outputRoot: path.join(workspace, ".buildchain/authority-result"),
  });
}
