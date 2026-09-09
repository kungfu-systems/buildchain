import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  command,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";

export function validateAttestationInput(env) {
  requireValue(
    /^[0-9a-f]{40}$/u.test(env.BUILDCHAIN_REF || ""),
    "buildchain-ref must be an exact 40-hex commit",
  );
  requireValue(
    env.BUILDCHAIN_REF === env.DEFINITION_SHA,
    "attester runtime must match the defining signer workflow SHA",
  );
  requireValue(
    env.EVIDENCE_RUN_ID === env.CURRENT_RUN_ID,
    "attestation inputs must come from the current caller workflow run",
  );
  requireValue(
    /^[0-9a-f]{40}$/u.test(env.SOURCE_SHA || "") &&
      env.SOURCE_SHA === env.CURRENT_SOURCE_SHA,
    "source-sha must equal the exact caller workflow SHA attested by GitHub",
  );
  for (const key of [
    "SUBJECT_RELATIVE_PATH",
    "PLATFORM_MANIFEST_RELATIVE_PATH",
    "RELEASE_PASSPORT_RELATIVE_PATH",
  ]) {
    const value = env[key] || "";
    requireValue(
      value &&
        !value.startsWith("/") &&
        !/[\\\0\r\n]/u.test(value) &&
        !value.split("/").includes(".."),
      "attestation input paths must be safe relative paths",
    );
  }
}
export function verifySigner(env) {
  const bytes = command(
    "gh",
    [
      "attestation",
      "verify",
      env.SUBJECT_PATH,
      "--repo",
      env.CALLER_REPOSITORY,
      "--signer-workflow",
      "kungfu-systems/buildchain/.github/workflows/public-release-artifact-attestation.yml",
      "--signer-digest",
      env.BUILDCHAIN_REF,
      "--source-digest",
      env.CALLER_SOURCE_SHA,
      "--predicate-type",
      env.PREDICATE_TYPE,
      "--bundle",
      env.BUNDLE_PATH,
      "--deny-self-hosted-runners",
      "--format",
      "json",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  fs.writeFileSync(
    ".buildchain/github-artifact-attestation/provider-verification.json",
    bytes,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOperation({ admit: validateAttestationInput, verify: verifySigner });
