if (
  process.env.FORK_PULL_REQUEST === "true" &&
  !process.env.GOVERNANCE_AUDITOR_TOKEN &&
  !process.env.GOVERNANCE_READ_TOKEN
) {
  console.warn(
    "::warning::Fork PR governance is credential-limited; the sanitized non-qualifying receipt is retained and protected independent review remains authoritative.",
  );
} else {
  console.error("::error::Managed-zone GitHub governance is non-qualifying.");
  process.exitCode = 1;
}
