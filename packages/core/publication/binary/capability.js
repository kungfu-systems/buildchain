import { requireValue } from "../../runtime/action-process.mjs";
export function validateBinaryCapability({
  capability,
  manifest,
  tag,
  sourceSha,
  now = Date.now(),
}) {
  const source = String(manifest.release?.sourceSha || "").replace(
    /^sha256:/u,
    "",
  );
  const digest = String(manifest.bundle?.sha256 || "").replace(/^sha256:/u, "");
  const expires = Date.parse(capability.expiresAt);
  const checks = [
    [capability.decision === "allow", "capability decision is not allow"],
    [
      capability.workflowPath ===
        ".github/workflows/.release-binary-assets.yml",
      "capability workflow mismatch",
    ],
    [
      capability.capabilityIds?.includes("github-release"),
      "github-release capability is missing",
    ],
    [
      capability.environment === "buildchain-release-assets",
      "capability environment mismatch",
    ],
    [capability.channel === "release-assets", "capability channel mismatch"],
    [
      capability.version === tag.replace(/^v/u, ""),
      "capability version mismatch",
    ],
    [manifest.release?.tag === tag, "evidence bundle tag mismatch"],
    [
      /^[0-9a-f]{40}$/u.test(source) &&
        source === sourceSha &&
        capability.sourceSha === source,
      "capability source mismatch",
    ],
    [
      /^[0-9a-f]{64}$/u.test(digest) && capability.artifactDigest === digest,
      "capability artifact mismatch",
    ],
    [
      Number.isFinite(expires) && expires > now,
      "capability is stale or has no valid expiry",
    ],
  ];
  const failures = checks
    .filter(([okay]) => !okay)
    .map(([, message]) => message);
  requireValue(failures.length === 0, failures.join("; "));
}
