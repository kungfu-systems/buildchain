import {
  BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY,
  compileEffectiveGithubGovernancePolicy,
  evaluateCodeownersAuthority,
  evaluateGithubGovernanceSnapshot,
  githubGovernanceDigest,
  githubRepositoryIdentityRoot,
  resolveGithubGovernanceTargetRefs,
} from "../github-governance-authority.js";
import { createGovernanceReader } from "./github-reader.js";
import {
  normalizeMembership,
  addMinutes,
  repositoryVisibility,
  selectGithubGovernanceRepositories,
} from "./identity.js";
function collectBranchGovernance({
  reader,
  fullName,
  branch,
  defaultBranch,
  repositoryState,
  branchesState,
  rulesetState,
  developmentMembership,
  reviewMembership,
  organizationState,
  repositoriesState,
  memberships,
  observedAt,
  ttlMinutes,
  verifier,
  repositoryIdentityRoot,
  visibilityClass,
}) {
  const { githubApi, readCodeowners, resolvedAbsence } = reader;
  const branchState = githubApi(
    `repos/${fullName}/branches/${encodeURIComponent(branch)}`,
    `${fullName} branch`,
  );
  const protectionState = githubApi(
    `repos/${fullName}/branches/${encodeURIComponent(branch)}/protection`,
    `${fullName} branch protection`,
  );
  const codeownersState = readCodeowners(fullName, branch);
  const codeowners = evaluateCodeownersAuthority({
    source: codeownersState.source,
    sourcePath: codeownersState.path,
    reviewAuthority:
      BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.authority.reviewIdentity,
  });
  const effectivePolicy = compileEffectiveGithubGovernancePolicy({
    branch,
    defaultBranch,
    protectedBranch: branchState.data?.protected === true,
    protection: protectionState.ok ? protectionState.data : null,
    rulesets: rulesetState.rulesets,
  });
  const apiEvidence = {
    complete:
      branchesState.readable &&
      branchState.ok &&
      resolvedAbsence(protectionState) &&
      rulesetState.readable &&
      codeownersState.readable &&
      developmentMembership.ok &&
      reviewMembership.ok,
    readable:
      branchesState.readable &&
      branchState.ok &&
      rulesetState.readable &&
      codeownersState.readable,
    ambiguous: false,
    provider: "github",
    endpointClasses: {
      organization: organizationState.ok ? "read" : organizationState.reason,
      repositories: repositoriesState.readable
        ? "read"
        : repositoriesState.result.reason,
      branches: branchesState.readable ? "read" : branchesState.result.reason,
      branch: branchState.ok ? "read" : branchState.reason,
      protection: protectionState.ok ? "read" : protectionState.reason,
      rulesets: rulesetState.readable ? "read" : rulesetState.listing.reason,
      codeowners: codeowners.exists
        ? "present"
        : codeownersState.readable
          ? "absent"
          : "unreadable",
      memberships:
        developmentMembership.ok && reviewMembership.ok ? "read" : "unreadable",
    },
  };
  const receipt = evaluateGithubGovernanceSnapshot({
    repository: repositoryState,
    targetRef: branch,
    organizationPlan: String(organizationState.data?.plan?.name || ""),
    codeowners,
    effectivePolicy,
    memberships,
    apiEvidence,
    observedAt,
    expiresAt: addMinutes(observedAt, ttlMinutes),
    verifier,
  });
  const diagnostic = {
    repositoryIdentityRoot,
    visibility: visibilityClass,
    targetRef: branch,
    endpointClasses: apiEvidence.endpointClasses,
    codeownersAttempts: codeownersState.attempts,
  };
  return { receipt, diagnostic };
}
export function collectGithubGovernanceAudit({
  organization = BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.organization,
  repository = "",
  targetRef = "",
  observedAt = new Date().toISOString(),
  ttlMinutes = 15,
  verifierSourceRevision = "",
  token,
  api,
} = {}) {
  if (api !== undefined) {
    throw new Error(
      "injected API clients must use collectGithubGovernanceAuditFromSnapshot",
    );
  }
  const reader = createGovernanceReader(token);
  const {
    githubApi,
    readRulesets,
    readBranchNames,
    readOrganizationRepositories,
  } = reader;
  const organizationState = githubApi(`orgs/${organization}`, "organization");
  const repositoriesState = readOrganizationRepositories(organization);
  const developmentMembership = githubApi(
    `orgs/${organization}/memberships/${BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.authority.developmentIdentity}`,
    "development membership",
  );
  const reviewMembership = githubApi(
    `orgs/${organization}/memberships/${BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.authority.reviewIdentity}`,
    "review membership",
  );
  if (!organizationState.ok || !repositoriesState.readable) {
    throw new Error(
      "organization or managed repository inventory is unreadable; governance audit fails closed",
    );
  }
  const selected = selectGithubGovernanceRepositories(
    repositoriesState.repositories,
    repository,
  );
  if (targetRef && selected.length !== 1) {
    throw new Error("--target-ref requires exactly one selected repository");
  }
  const revision = verifierSourceRevision;
  const verifier = {
    runtime: `node-${process.version}`,
    sourceRevision: revision,
    identityRoot: githubGovernanceDigest({
      contract: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.contract,
      policyRoot: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.policyRoot,
      sourceRevision: revision,
      runtime: process.version,
    }),
  };
  const memberships = {
    [BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.authority.developmentIdentity]:
      normalizeMembership(developmentMembership),
    [BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.authority.reviewIdentity]:
      normalizeMembership(reviewMembership),
  };
  const receipts = [];
  const diagnostics = [];
  for (const metadata of selected) {
    const fullName = String(metadata.full_name || "");
    const visibilityClass = repositoryVisibility(metadata);
    const repositoryIdentityRoot = githubRepositoryIdentityRoot({
      provider: "github",
      providerRepositoryId: String(metadata.node_id || metadata.id || ""),
    });
    const defaultBranch = String(metadata.default_branch || "").replace(
      /^refs\/heads\//,
      "",
    );
    const repositoryState = {
      fullName,
      visibility: visibilityClass,
      identityRoot: repositoryIdentityRoot,
      defaultBranch,
    };
    const branchesState = targetRef
      ? {
          readable: true,
          result: { ok: true, reason: "targeted-read" },
          names: [String(targetRef).replace(/^refs\/heads\//, "")],
        }
      : readBranchNames(fullName);
    const branches = resolveGithubGovernanceTargetRefs({
      repository: repositoryState,
      availableRefs: branchesState.names,
      requestedTargetRef: targetRef,
    });
    const rulesetState = readRulesets(fullName);
    for (const branch of branches) {
      const { receipt, diagnostic } = collectBranchGovernance({
        reader,
        fullName,
        branch,
        defaultBranch,
        repositoryState,
        branchesState,
        rulesetState,
        developmentMembership,
        reviewMembership,
        organizationState,
        repositoriesState,
        memberships,
        observedAt,
        ttlMinutes,
        verifier,
        repositoryIdentityRoot,
        visibilityClass,
      });
      receipts.push(receipt);
      diagnostics.push(diagnostic);
    }
  }
  const visibility = selected.reduce((counts, item) => {
    const key = repositoryVisibility(item);
    counts[key] = Number(counts[key] || 0) + 1;
    return counts;
  }, {});
  const core = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-github-governance-audit",
    organization,
    policyRoot: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.policyRoot,
    organizationPlan: String(organizationState.data?.plan?.name || "unknown"),
    observedAt,
    expiresAt: addMinutes(observedAt, ttlMinutes),
    inventory: {
      repositoryCount: selected.length,
      targetCount: receipts.length,
      visibility,
      qualifyingCount: receipts.filter((receipt) => receipt.qualifying).length,
      nonQualifyingCount: receipts.filter((receipt) => !receipt.qualifying)
        .length,
    },
    receipts,
    diagnostics,
    verifier,
  };
  return { ...core, auditRoot: githubGovernanceDigest(core) };
}
