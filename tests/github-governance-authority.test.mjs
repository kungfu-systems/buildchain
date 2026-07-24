import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY,
  codeownersForPath,
  compileEffectiveGithubGovernancePolicy,
  createGithubGovernanceRolloutPlan,
  evaluateCodeownersAuthority,
  evaluateGithubGovernanceSnapshot,
  githubGovernanceDigest,
  normalizeGithubBranchProtectionSnapshot,
  parseCodeowners,
  verifyGithubGovernanceReceipt,
} from "../packages/core/github-governance-authority.js";
import { resolveVerifierSourceRevision } from "../scripts/audit-github-governance.mjs";

const CODEOWNERS = `* @kungfu-origin
/.github/CODEOWNERS @kungfu-origin
/.github/workflows/.publication-authority.yml @kungfu-origin
/packages/core/github-governance-authority.js @kungfu-origin
/scripts/audit-github-governance.mjs @kungfu-origin
/scripts/reconcile-github-governance.mjs @kungfu-origin
/.github/workflows/github-governance-audit.yml @kungfu-origin
`;

function classicProtection() {
  return {
    required_status_checks: {
      strict: true,
      checks: [{ context: "Source Acceptance" }, { context: "DCO" }],
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      required_approving_review_count: 1,
      require_last_push_approval: true,
    },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
}

function qualifyingInput(overrides = {}) {
  const effectivePolicy = compileEffectiveGithubGovernancePolicy({
    branch: "dev/v2/v2.14",
    defaultBranch: "dev/v2/v2.14",
    protectedBranch: true,
    protection: classicProtection(),
  });
  return {
    repository: {
      fullName: "kungfu-systems/buildchain",
      visibility: "public",
    },
    targetRef: "dev/v2/v2.14",
    organizationPlan: "free",
    codeowners: evaluateCodeownersAuthority({
      source: CODEOWNERS,
      sourcePath: ".github/CODEOWNERS",
    }),
    effectivePolicy,
    memberships: {
      dongkeren: { state: "active", role: "member" },
      "kungfu-origin": { state: "active", role: "admin" },
    },
    apiEvidence: {
      complete: true,
      readable: true,
      ambiguous: false,
      provider: "github",
    },
    observedAt: "2026-07-24T01:00:00Z",
    expiresAt: "2026-07-24T01:15:00Z",
    verifier: {
      runtime: "node-v24",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      identityRoot: githubGovernanceDigest("verifier"),
    },
    ...overrides,
  };
}

test("authority descriptor freezes the TCB, baseline, plan boundary, and non-claims", () => {
  const descriptor = BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY;
  assert.equal(descriptor.organization, "kungfu-systems");
  assert.equal(descriptor.repositoryAdmission.baseline.repositoryCount, 16);
  assert.equal(descriptor.repositoryAdmission.publicRepositories.length, 13);
  assert.deepEqual(descriptor.planCapability.privateRepositories, ["team", "enterprise"]);
  assert.match(descriptor.trustedComputingBase.nonClaims.join("\n"), /GitHub platform compromise/);
  assert.equal(descriptor.policyRoot, githubGovernanceDigest(
    Object.fromEntries(Object.entries(descriptor).filter(([key]) => key !== "policyRoot")),
  ));
});

test("CODEOWNERS last-match authority protects the authority file and verifier surfaces", () => {
  assert.equal(parseCodeowners(CODEOWNERS).length, 7);
  assert.deepEqual(codeownersForPath(CODEOWNERS, ".github/CODEOWNERS"), ["@kungfu-origin"]);
  assert.deepEqual(
    codeownersForPath(
      `${CODEOWNERS}/.github/CODEOWNERS @dongkeren\n`,
      ".github/CODEOWNERS",
    ),
    ["@dongkeren"],
  );
  const authority = evaluateCodeownersAuthority({
    source: CODEOWNERS,
    sourcePath: ".github/CODEOWNERS",
  });
  assert.equal(authority.allProtectedPathsOwned, true);
  assert.match(authority.sourceDigest, /^sha256:[0-9a-f]{64}$/);
});

test("classic protection compiles to one effective fail-closed policy", () => {
  const policy = compileEffectiveGithubGovernancePolicy({
    branch: "dev/v2/v2.14",
    defaultBranch: "dev/v2/v2.14",
    protectedBranch: true,
    protection: classicProtection(),
  });
  assert.equal(policy.nativePullRequestRequired, true);
  assert.equal(policy.codeOwnerReviewRequired, true);
  assert.equal(policy.enforceAdmins, true);
  assert.deepEqual(policy.requiredChecks, ["DCO", "Source Acceptance"]);
  assert.equal(policy.allowForcePushes, false);
  assert.equal(policy.allowDeletions, false);
});

test("repository and organization rulesets aggregate with classic protection", () => {
  const policy = compileEffectiveGithubGovernancePolicy({
    branch: "main",
    defaultBranch: "main",
    protectedBranch: true,
    rulesets: [{
      id: 42,
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 1,
            require_code_owner_review: true,
            dismiss_stale_reviews_on_push: true,
            require_last_push_approval: true,
            required_review_thread_resolution: true,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [{ context: "check" }],
          },
        },
        { type: "non_fast_forward" },
        { type: "deletion" },
      ],
    }],
  });
  assert.equal(policy.protected, true);
  assert.equal(policy.enforceAdmins, true);
  assert.deepEqual(policy.bypassActors, []);
  assert.equal(policy.allowForcePushes, false);
  assert.equal(policy.allowDeletions, false);
  assert.deepEqual(policy.requiredChecks, ["check"]);
  assert.equal(policy.applicableRulesetRoots.length, 1);
});

test("qualifying receipt binds policy, ownership, effective rules, authority, and freshness", () => {
  const receipt = evaluateGithubGovernanceSnapshot(qualifyingInput());
  assert.equal(receipt.qualifying, true);
  assert.equal(receipt.status, "qualifying");
  assert.deepEqual(receipt.failureIds, []);
  assert.match(receipt.receiptRoot, /^sha256:[0-9a-f]{64}$/);
  assert.ok(receipt.requiredChecks.includes("Source Acceptance"));
  assert.equal(
    verifyGithubGovernanceReceipt(receipt, {
      expectedOrganization: "kungfu-systems",
      expectedRepository: "kungfu-systems/buildchain",
      expectedTargetRef: "dev/v2/v2.14",
      expectedPolicyRoot: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.policyRoot,
      expectedVerifierSourceRevision: "0123456789abcdef0123456789abcdef01234567",
      now: "2026-07-24T01:10:00Z",
    }),
    receipt,
  );
  assert.throws(
    () => verifyGithubGovernanceReceipt(receipt, {
      expectedVerifierSourceRevision: "ffffffffffffffffffffffffffffffffffffffff",
      now: "2026-07-24T01:10:00Z",
    }),
    /verifier source revision mismatch/,
  );
});

test("development admin authority fails least privilege even when branch policy is green", () => {
  const receipt = evaluateGithubGovernanceSnapshot(qualifyingInput({
    memberships: {
      dongkeren: { state: "active", role: "admin" },
      "kungfu-origin": { state: "active", role: "admin" },
    },
  }));
  assert.equal(receipt.qualifying, false);
  assert.ok(receipt.failureIds.includes("development-least-privilege"));
  assert.throws(() => verifyGithubGovernanceReceipt(receipt), /non-qualifying/);
});

test("private repositories on Free remain anonymous and non-qualifying", () => {
  const receipt = evaluateGithubGovernanceSnapshot(qualifyingInput({
    repository: {
      fullName: "kungfu-systems/private-control",
      visibility: "private",
      identityRoot: githubGovernanceDigest("kungfu-systems/private-control"),
    },
  }));
  assert.equal(receipt.repository, null);
  assert.equal(receipt.visibility, "private");
  assert.equal(receipt.planCapability.qualifying, false);
  assert.ok(receipt.failureIds.includes("plan-capability"));
  assert.equal(JSON.stringify(receipt).includes("private-control"), false);
});

test("latest-push review, Code Owner self-protection, bypass, and provider-read failures deny", () => {
  const weakPolicy = {
    ...qualifyingInput().effectivePolicy,
    dismissStaleReviews: false,
    requireLastPushApproval: false,
    bypassActors: [{ actorType: "OrganizationAdmin", bypassMode: "always", actorId: 1 }],
  };
  const weakOwners = evaluateCodeownersAuthority({
    source: `${CODEOWNERS}/.github/CODEOWNERS @dongkeren\n`,
    sourcePath: ".github/CODEOWNERS",
  });
  const receipt = evaluateGithubGovernanceSnapshot(qualifyingInput({
    effectivePolicy: weakPolicy,
    codeowners: weakOwners,
    apiEvidence: { complete: false, readable: false, ambiguous: true },
  }));
  assert.deepEqual(
    receipt.failureIds.filter((id) =>
      ["api-evidence", "codeowners-authority", "fresh-review", "bypass-policy"].includes(id)),
    ["api-evidence", "codeowners-authority", "fresh-review", "bypass-policy"],
  );
});

test("rollout plan requires frozen inventory and carries exact rollback", () => {
  assert.throws(() => createGithubGovernanceRolloutPlan({
    repository: "kungfu-systems/buildchain",
    targetRef: "dev/v2/v2.14",
  }), /inventory and frozen rollback/);
  const rollbackSnapshot = classicProtection();
  const plan = createGithubGovernanceRolloutPlan({
    repository: "kungfu-systems/buildchain",
    targetRef: "dev/v2/v2.14",
    inventory: { repository: "kungfu-systems/buildchain", observedAt: "2026-07-24T01:00:00Z" },
    rollbackSnapshot,
    desiredProtection: {
      strictRequiredChecks: true,
      requiredChecks: ["DCO", "Source Acceptance"],
      requiredApprovals: 1,
    },
  });
  assert.equal(plan.operations[0].method, "PUT");
  assert.equal(plan.rollback[0].body, rollbackSnapshot);
  assert.equal(plan.rollback[0].preconditionRoot, plan.rollbackSnapshotRoot);
  assert.match(plan.planRoot, /^sha256:[0-9a-f]{64}$/);
});

test("provider branch protection normalizes into an exact reversible write body", () => {
  const normalized = normalizeGithubBranchProtectionSnapshot({
    ...classicProtection(),
    required_pull_request_reviews: {
      ...classicProtection().required_pull_request_reviews,
      dismissal_restrictions: {
        users: [{ login: "kungfu-origin" }],
        teams: [],
        apps: [],
      },
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    },
    restrictions: {
      users: [{ login: "kungfu-origin" }],
      teams: [{ slug: "release" }],
      apps: [],
    },
  });
  assert.deepEqual(normalized.required_status_checks.checks, [
    { context: "Source Acceptance", app_id: null },
    { context: "DCO", app_id: null },
  ]);
  assert.deepEqual(
    normalized.required_pull_request_reviews.dismissal_restrictions.users,
    ["kungfu-origin"],
  );
  assert.deepEqual(normalized.restrictions.teams, ["release"]);
  assert.equal(normalized.enforce_admins, true);
});

test("tampering and stale receipts are rejected", () => {
  const receipt = evaluateGithubGovernanceSnapshot(qualifyingInput());
  assert.throws(
    () => verifyGithubGovernanceReceipt({ ...receipt, targetRef: "main" }),
    /root mismatch/,
  );
  assert.throws(
    () => verifyGithubGovernanceReceipt(receipt, { now: "2026-07-24T01:16:00Z" }),
    /freshness/,
  );
});

test("auditor source identity must equal the exact verifier checkout", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const cleanRun = (_command, args) => args.includes("rev-parse")
    ? { status: 0, stdout: `${head}\n` }
    : { status: 0, stdout: "" };
  assert.equal(resolveVerifierSourceRevision("/verifier", head, cleanRun), head);
  assert.throws(
    () => resolveVerifierSourceRevision(
      "/verifier",
      "ffffffffffffffffffffffffffffffffffffffff",
      cleanRun,
    ),
    /does not match the current checkout/,
  );
  assert.throws(
    () => resolveVerifierSourceRevision(
      "/verifier",
      head,
      (_command, args) => args.includes("rev-parse")
        ? { status: 0, stdout: `${head}\n` }
        : { status: 1, stdout: "" },
    ),
    /contains tracked drift/,
  );
});
