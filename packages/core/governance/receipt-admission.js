import { command } from "../runtime/action-process.mjs";
import {
  BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY,
  verifyGithubGovernanceReceipt,
} from "./github-governance-authority.js";

export function admitGithubGovernanceReceipt(
  { receipt, repository, targetRef, runtimeRoot, runtimeSha },
  execute = command,
) {
  if (!receipt)
    throw new Error(
      "Production publication requires a fresh GitHub governance receipt",
    );
  const actual = execute("git", ["-C", runtimeRoot, "rev-parse", "HEAD"], {
    stdio: "pipe",
  })
    .trim()
    .toLowerCase();
  if (
    !/^[0-9a-f]{40}$/.test(actual) ||
    actual !== String(runtimeSha).toLowerCase()
  )
    throw new Error(
      "Governance verifier checkout does not match the exact Buildchain runtime",
    );
  return verifyGithubGovernanceReceipt(receipt, {
    expectedOrganization: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.organization,
    expectedRepository: repository,
    expectedTargetRef: targetRef,
    expectedPolicyRoot: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.policyRoot,
    expectedVerifierSourceRevision: actual,
  });
}
