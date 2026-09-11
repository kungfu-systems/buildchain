import {
  BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY,
  verifyGithubGovernanceReceipt,
} from "./github-governance-authority.js";

export function admitGithubGovernanceReceipt(
  { receipt, repository, targetRef, runtimeRoot, runtimeSha },
) {
  if (!receipt)
    throw new Error(
      "Production publication requires a fresh GitHub governance receipt",
    );
  return verifyGithubGovernanceReceipt(receipt, {
    expectedOrganization: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.organization,
    expectedRepository: repository,
    expectedTargetRef: targetRef,
    expectedPolicyRoot: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.policyRoot,
  });
}
