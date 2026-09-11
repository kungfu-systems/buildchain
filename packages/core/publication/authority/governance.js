import fs from "node:fs";
import path from "node:path";
import { collectGithubGovernanceAudit } from "../../governance/audit/collection.js";
import {
  BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY,
  verifyGithubGovernanceReceipt,
} from "../../governance/github-governance-authority.js";
export function verifyLivePublicationGovernance(
  { repository, targetRef, runtimeSha, outputRoot, token },
  collect = collectGithubGovernanceAudit,
) {
  if (!repository || !targetRef || !token)
    throw new Error(
      "Live GitHub governance verification requires an exact repository, target ref and scoped credential",
    );

  fs.mkdirSync(outputRoot, { recursive: true });
  const audit = collect({
    token,
    organization: repository.split("/")[0],
    repository,
    targetRef,
    verifierSourceRevision: runtimeSha,
    ttlMinutes: 15,
  });
  fs.writeFileSync(
    path.join(outputRoot, "github-governance-audit.json"),
    `${JSON.stringify(audit, null, 2)}\n`,
  );
  if (audit.inventory?.nonQualifyingCount > 0)
    throw Object.assign(new Error("Live governance audit is non-qualifying"), {
      status: 2,
    });
  if (
    audit.inventory?.repositoryCount !== 1 ||
    audit.inventory?.targetCount !== 1 ||
    audit.receipts?.length !== 1
  )
    throw new Error(
      "live governance audit did not resolve exactly one repository and target",
    );
  const receipt = audit.receipts[0];
  verifyGithubGovernanceReceipt(receipt, {
    expectedOrganization: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.organization,
    expectedRepository: repository,
    expectedTargetRef: targetRef,
    expectedPolicyRoot: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.policyRoot,
  });
  fs.writeFileSync(
    path.join(outputRoot, "github-governance-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}
