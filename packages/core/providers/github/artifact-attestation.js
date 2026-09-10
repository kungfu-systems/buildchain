import fs from "node:fs";
import { command } from "../../runtime/action-process.mjs";
export function verifyArtifactAttestationSigner(request, execute = command) {
  const bytes = execute(
    "gh",
    [
      "attestation",
      "verify",
      request.subjectPath,
      "--repo",
      request.repository,
      "--signer-workflow",
      "kungfu-systems/buildchain/.github/workflows/public-release-artifact-attestation.yml",
      "--signer-digest",
      request.runtimeSha,
      "--source-digest",
      request.sourceSha,
      "--predicate-type",
      request.predicateType,
      "--bundle",
      request.bundlePath,
      "--deny-self-hosted-runners",
      "--format",
      "json",
    ],
    {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...request.environment, GH_TOKEN: request.token },
    },
  );
  fs.writeFileSync(request.outputPath, bytes);
}
