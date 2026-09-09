import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY,
  verifyGithubGovernanceReceipt,
} from "../../governance/github-governance-authority.js";
import { auditGovernance } from "./authority-io.mjs";

export async function verifyLiveGovernance(env) {
  const repository = env.BUILDCHAIN_GITHUB_GOVERNANCE_EXPECTED_REPOSITORY;
  const targetRef = env.BUILDCHAIN_GITHUB_GOVERNANCE_EXPECTED_TARGET_REF;
  const actualRuntimeSha = execFileSync(
    "git",
    ["-C", ".buildchain/authority-runtime", "rev-parse", "HEAD"],
    { encoding: "utf8" },
  )
    .trim()
    .toLowerCase();
  const expectedRuntimeSha = env.BUILDCHAIN_AUTHORITY_REF.toLowerCase();
  if (actualRuntimeSha !== expectedRuntimeSha) {
    throw new Error(
      `governance verifier checkout mismatch: expected ${expectedRuntimeSha}, got ${actualRuntimeSha}`,
    );
  }
  await auditGovernance(env);
  const audit = JSON.parse(
    fs.readFileSync(
      ".buildchain/publication-authority/github-governance-audit.json",
      "utf8",
    ),
  );
  if (
    audit.inventory?.repositoryCount !== 1 ||
    audit.inventory?.targetCount !== 1 ||
    audit.receipts?.length !== 1
  ) {
    throw new Error(
      "live governance audit did not resolve exactly one repository and target",
    );
  }
  const receipt = audit.receipts[0];
  verifyGithubGovernanceReceipt(receipt, {
    expectedOrganization: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.organization,
    expectedRepository: repository,
    expectedTargetRef: targetRef,
    expectedPolicyRoot: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.policyRoot,
    expectedVerifierSourceRevision: actualRuntimeSha,
  });
  fs.writeFileSync(
    ".buildchain/publication-authority/github-governance-receipt.json",
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}
