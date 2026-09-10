import { requireValue } from "../../runtime/action-process.mjs";
export function validateAttestationInput(request) {
  requireValue(
    /^[0-9a-f]{40}$/u.test(request.runtimeSha || ""),
    "buildchain-ref must be an exact 40-hex commit",
  );
  requireValue(
    request.runtimeSha === request.definitionSha,
    "attester runtime must match the defining signer workflow SHA",
  );
  requireValue(
    request.evidenceRunId === request.currentRunId,
    "attestation inputs must come from the current caller workflow run",
  );
  requireValue(
    /^[0-9a-f]{40}$/u.test(request.sourceSha || "") &&
      request.sourceSha === request.currentSourceSha,
    "source-sha must equal the exact caller workflow SHA attested by GitHub",
  );
  for (const key of [
    "subjectRelativePath",
    "platformManifestRelativePath",
    "releasePassportRelativePath",
  ]) {
    const value = request[key] || "";
    requireValue(
      value &&
        !value.startsWith("/") &&
        !/[\\\0\r\n]/u.test(value) &&
        !value.split("/").includes(".."),
      "attestation input paths must be safe relative paths",
    );
  }
}
