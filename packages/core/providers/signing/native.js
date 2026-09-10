import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
export function signMacosPayload(
  {
    runtimeRoot,
    payload,
    evidencePath,
    artifact,
    signature,
    credentials,
    environment,
  },
  execute = command,
) {
  execute(
    "bash",
    [
      path.join(
        runtimeRoot,
        "packages/core/providers/signing/macos/sign-request.sh",
      ),
    ],
    {
      cwd: runtimeRoot,
      env: {
        ...environment,
        BUILDCHAIN_SIGNED_PAYLOAD: payload,
        BUILDCHAIN_SIGNING_EVIDENCE: evidencePath,
        BUILDCHAIN_ARTIFACT_KIND: artifact.kind,
        BUILDCHAIN_ENTITLEMENTS_PROFILE:
          signature.entitlementsProfile || "none",
        BUILDCHAIN_ENTITLEMENTS_PATHS: (signature.entitlementsPaths || []).join(
          ",",
        ),
        BUILDCHAIN_APPLE_CERTIFICATE_P12_BASE64: credentials.certificateBase64,
        BUILDCHAIN_APPLE_CERTIFICATE_PASSWORD: credentials.certificatePassword,
        BUILDCHAIN_APPLE_CERTIFICATE_SHA1: credentials.certificateSha1,
        BUILDCHAIN_APPLE_TEAM_ID: credentials.teamId,
        BUILDCHAIN_APPLE_NOTARY_KEY_P8_BASE64: credentials.notaryKeyBase64,
        BUILDCHAIN_APPLE_NOTARY_KEY_ID: credentials.notaryKeyId,
        BUILDCHAIN_APPLE_NOTARY_ISSUER: credentials.notaryIssuer,
      },
    },
  );
}
export function signWindowsPayload(
  { runtimeRoot, payload, evidencePath, credentials, environment },
  execute = command,
) {
  execute(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(
        runtimeRoot,
        "packages/core/providers/signing/windows/sign-request.ps1",
      ),
    ],
    {
      cwd: runtimeRoot,
      env: {
        ...environment,
        BUILDCHAIN_SIGNED_PAYLOAD: payload,
        BUILDCHAIN_SIGNING_EVIDENCE: evidencePath,
        BUILDCHAIN_WINDOWS_CERTIFICATE_PFX_BASE64:
          credentials.certificateBase64,
        BUILDCHAIN_WINDOWS_CERTIFICATE_PASSWORD:
          credentials.certificatePassword,
        BUILDCHAIN_WINDOWS_CERTIFICATE_SHA1: credentials.certificateSha1,
        BUILDCHAIN_WINDOWS_TIMESTAMP_URL: credentials.timestampUrl,
      },
    },
  );
}
