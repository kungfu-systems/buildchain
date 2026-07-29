import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY,
  codeownersForPath,
  compileEffectiveGithubGovernancePolicy,
  createGithubGovernanceRolloutPlan,
  createGithubRulesetBypassRolloutPlan,
  createGithubRulesetGovernanceRolloutPlan,
  evaluateCodeownersAuthority,
  evaluateGithubGovernanceSnapshot,
  githubGovernanceDigest,
  githubRepositoryIdentityRoot,
  normalizeGithubBranchProtectionSnapshot,
  normalizeGithubRulesetSnapshot,
  parseCodeowners,
  resolveGithubGovernanceTargetPolicy,
  resolveGithubGovernanceTargetRefs,
  verifyGithubGovernanceReceipt,
} from "../packages/core/github-governance-authority.js";
import { resolveVerifierSourceRevision } from "../scripts/audit-github-governance.mjs";
import {
  githubApiFailureIsAbsence,
  resolveGithubProtectionTargetPolicy,
  resolveRequiredCheckBindings,
} from "../scripts/reconcile-github-governance.mjs";

const CODEOWNERS = `* @kungfu-origin
/.github/CODEOWNERS @kungfu-origin
/.github/workflows/.publication-authority.yml @kungfu-origin
/.github/workflows/.release-candidate-promote.yml @kungfu-origin
/.github/workflows/buildchain-ref-promotion.yml @kungfu-origin
/.github/workflows/paper-release-sealed.yml @kungfu-origin
/.github/workflows/paper-release.yml @kungfu-origin
/.github/workflows/release-line-bootstrap.yml @kungfu-origin
/.github/workflows/release-candidate-promote.yml @kungfu-origin
/actions/promote-buildchain-ref/action.yml @kungfu-origin
/actions/promote-buildchain-ref/dist/index.js @kungfu-origin
/actions/promote-buildchain-ref/index.js @kungfu-origin
/actions/promote-buildchain-ref/lib.js @kungfu-origin
/packages/core/buildchain-publication-authority.js @kungfu-origin
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
  const protection = classicProtection();
  protection.required_status_checks = {
    strict: false,
    checks: [{ context: "check", app_id: 15368 }],
    contexts: ["check"],
  };
  const effectivePolicy = compileEffectiveGithubGovernancePolicy({
    branch: "dev/v3/v3.0",
    defaultBranch: "dev/v3/v3.0",
    protectedBranch: true,
    protection,
  });
  return {
    repository: {
      fullName: "kungfu-systems/buildchain",
      visibility: "public",
    },
    targetRef: "dev/v3/v3.0",
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
  assert.equal(descriptor.repositoryAdmission.baseline.repositoryCount, 17);
  assert.equal(descriptor.repositoryAdmission.publicRepositories.length, 14);
  assert.equal(descriptor.repositoryAdmission.privateRepositoryIdentities.length, 3);
  assert.equal(descriptor.repositoryAdmission.baseline.authoritativePublicTargetCount, 38);
  assert.deepEqual(descriptor.planCapability.privateRepositories, ["team", "enterprise"]);
  assert.match(descriptor.trustedComputingBase.nonClaims.join("\n"), /GitHub platform compromise/);
  assert.equal(descriptor.policyRoot, githubGovernanceDigest(
    Object.fromEntries(Object.entries(descriptor).filter(([key]) => key !== "policyRoot")),
  ));
});

test("CODEOWNERS last-match authority protects the authority file and verifier surfaces", () => {
  assert.equal(parseCodeowners(CODEOWNERS).length, 18);
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
    branch: "dev/v3/v3.0",
    defaultBranch: "dev/v3/v3.0",
    protectedBranch: true,
    protection: classicProtection(),
  });
  assert.equal(policy.nativePullRequestRequired, true);
  assert.equal(policy.codeOwnerReviewRequired, true);
  assert.equal(policy.enforceAdmins, true);
  assert.deepEqual(policy.requiredChecks, ["DCO", "Source Acceptance"]);
  assert.deepEqual(policy.requiredCheckBindings, [
    { context: "DCO", appId: null },
    { context: "Source Acceptance", appId: null },
  ]);
  assert.equal(policy.allowForcePushes, false);
  assert.equal(policy.allowDeletions, false);
});

test("classic status checks prefer App-bound checks over legacy duplicate contexts", () => {
  const protection = classicProtection();
  protection.required_status_checks = {
    strict: false,
    checks: [{ context: "check", app_id: 15368 }],
    contexts: ["check"],
  };
  const policy = compileEffectiveGithubGovernancePolicy({
    branch: "dev/v3/v3.0",
    defaultBranch: "dev/v3/v3.0",
    protectedBranch: true,
    protection,
  });
  assert.deepEqual(policy.requiredCheckBindings, [{
    context: "check",
    appId: 15368,
  }]);
  assert.equal(evaluateGithubGovernanceSnapshot(qualifyingInput({
    effectivePolicy: policy,
  })).qualifying, true);
});

test("classic branch-protection bypass allowances are effective bypass actors", () => {
  const protection = classicProtection();
  protection.required_pull_request_reviews.bypass_pull_request_allowances = {
    users: [{ id: 209317, login: "dongkeren" }],
    teams: [],
    apps: [],
  };
  const policy = compileEffectiveGithubGovernancePolicy({
    branch: "dev/v3/v3.0",
    defaultBranch: "dev/v3/v3.0",
    protectedBranch: true,
    protection,
  });
  assert.deepEqual(policy.bypassActors, [{
    actorType: "User",
    bypassMode: "always",
    actorId: 209317,
  }]);
  const receipt = evaluateGithubGovernanceSnapshot(qualifyingInput({
    effectivePolicy: policy,
  }));
  assert.ok(receipt.failureIds.includes("bypass-policy"));
});

test("only the target-bound GitHub Actions App bypass is admitted", () => {
  const protection = qualifyingInput().effectivePolicy;
  const admitted = evaluateGithubGovernanceSnapshot(qualifyingInput({
    effectivePolicy: {
      ...protection,
      bypassActors: [{
        actorType: "Integration",
        actorId: 15368,
        bypassMode: "always",
      }],
    },
  }));
  assert.equal(admitted.qualifying, true);

  const substituted = evaluateGithubGovernanceSnapshot(qualifyingInput({
    effectivePolicy: {
      ...protection,
      bypassActors: [{
        actorType: "Integration",
        actorId: 999999,
        bypassMode: "always",
      }],
    },
  }));
  assert.ok(substituted.failureIds.includes("bypass-policy"));
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
  assert.deepEqual(receipt.requiredCheckBindings, [{
    context: "check",
    appId: 15368,
  }]);
  assert.equal(
    verifyGithubGovernanceReceipt(receipt, {
      expectedOrganization: "kungfu-systems",
      expectedRepository: "kungfu-systems/buildchain",
      expectedTargetRef: "dev/v3/v3.0",
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

test("private admission uses a policy-independent provider identity root and sealed target checks", () => {
  const descriptor = structuredClone(BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY);
  const identityRoot = descriptor.repositoryAdmission.privateRepositoryIdentities[0].identityRoot;
  const requiredCheckBindings = [{ context: "check", appId: 15368 }];
  descriptor.repositoryAdmission.privateRepositoryIdentities[0].requiredCheckPolicies = {
    "dev/v3/v3.0": {
      requiredCheckBindingRoot: githubGovernanceDigest(requiredCheckBindings),
      strictRequiredChecks: false,
    },
  };
  const { policyRoot: ignored, ...descriptorCore } = descriptor;
  descriptor.policyRoot = githubGovernanceDigest(descriptorCore);
  assert.equal(
    githubRepositoryIdentityRoot({
      provider: "github",
      providerRepositoryId: "R_private_stable_id",
    }),
    githubGovernanceDigest({
      provider: "github",
      providerRepositoryId: "R_private_stable_id",
    }),
  );
  const input = qualifyingInput({
    descriptor,
    repository: {
      fullName: "kungfu-systems/private-control",
      visibility: "private",
      identityRoot,
      defaultBranch: "dev/v3/v3.0",
    },
    organizationPlan: "team",
  });
  const receipt = evaluateGithubGovernanceSnapshot(input);
  assert.equal(receipt.qualifying, true);
  assert.equal(receipt.admission, "admitted-private");
  assert.equal(receipt.targetAdmission, "admitted-authoritative-target");
  assert.equal(receipt.repository, null);
  assert.equal(JSON.stringify(receipt).includes("private-control"), false);
});

test("authoritative target registry detects default drift and constrains private version lines", () => {
  const publicTargets = resolveGithubGovernanceTargetRefs({
    repository: {
      fullName: "kungfu-systems/buildchain",
      visibility: "public",
      defaultBranch: "dev/v2/v2.15",
    },
  });
  assert.ok(publicTargets.includes("dev/v3/v3.0"));
  assert.ok(publicTargets.includes("alpha/v3/v3.0"));
  assert.ok(publicTargets.includes("release/v3/v3.0"));
  assert.ok(publicTargets.includes("authority/v3/v3.0/artifact-signing"));
  assert.ok(publicTargets.includes("publish-gate/major"));
  assert.ok(publicTargets.includes("dev/v2/v2.15"));

  const machineLifePaperTargets = resolveGithubGovernanceTargetRefs({
    repository: {
      fullName: "kungfu-systems/paper-kfd-machine-life-roadmap",
      visibility: "public",
      defaultBranch: "main",
    },
  });
  assert.deepEqual(machineLifePaperTargets, [
    "alpha/v0/v0.1",
    "dev/v0/v0.1",
    "main",
  ]);

  const privateTargets = resolveGithubGovernanceTargetRefs({
    repository: {
      fullName: "kungfu-systems/private-control",
      visibility: "private",
      identityRoot:
        BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.repositoryAdmission
          .privateRepositoryIdentities[0].identityRoot,
      defaultBranch: "dev/v7/v7.3",
    },
    availableRefs: [
      "dev/v7/v7.3",
      "alpha/v7/v7.3",
      "release/v7/v7.3",
      "dev/v7/v7.2",
    ],
  });
  assert.deepEqual(privateTargets, [
    "dev/v7/v7.3",
    "alpha/v7/v7.3",
    "release/v7/v7.3",
  ]);
});

test("formal artifact-signing authority is admitted with exact checks and no bypass", () => {
  const policy = resolveGithubGovernanceTargetPolicy({
    repository: "kungfu-systems/buildchain",
    targetRef: "authority/v3/v3.0/artifact-signing",
  });
  assert.deepEqual(policy.requiredCheckBindings, [
    { context: "check", appId: 15368 },
    { context: "verify", appId: 15368 },
  ]);
  assert.equal(policy.strictRequiredChecks, true);
  assert.deepEqual(policy.allowedBypassActors, []);
  assert.equal(policy.requiredApprovals, 1);
});

test("unadmitted targets, required-check removal, producer substitution, and strict drift deny", () => {
  const unadmitted = evaluateGithubGovernanceSnapshot(qualifyingInput({
    targetRef: "dev/v2/v2.13",
  }));
  assert.ok(unadmitted.failureIds.includes("target-ref-admission"));

  const baseline = qualifyingInput().effectivePolicy;
  for (const [label, effectivePolicy, expectedFailure] of [
    [
      "required check removal",
      { ...baseline, requiredChecks: [], requiredCheckBindings: [] },
      "required-checks",
    ],
    [
      "required check producer substitution",
      {
        ...baseline,
        requiredCheckBindings: [{ context: "check", appId: 999999 }],
      },
      "required-checks",
    ],
    [
      "required check strict drift",
      { ...baseline, strictRequiredChecks: true },
      "strict-required-checks",
    ],
  ]) {
    const receipt = evaluateGithubGovernanceSnapshot(qualifyingInput({ effectivePolicy }));
    assert.ok(receipt.failureIds.includes(expectedFailure), label);
  }
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
    targetRef: "dev/v3/v3.0",
  }), /inventory and frozen rollback/);
  const rollbackSnapshot = classicProtection();
  const plan = createGithubGovernanceRolloutPlan({
    repository: "kungfu-systems/buildchain",
    targetRef: "dev/v3/v3.0",
    inventory: { repository: "kungfu-systems/buildchain", observedAt: "2026-07-24T01:00:00Z" },
    rollbackSnapshot,
    desiredProtection: {
      strictRequiredChecks: true,
      requiredCheckBindings: [
        { context: "DCO", app_id: 15368 },
        { context: "Source Acceptance", app_id: 15368 },
      ],
      requiredApprovals: 1,
    },
  });
  assert.equal(plan.operations[0].method, "PUT");
  assert.equal(plan.rollback[0].body, rollbackSnapshot);
  assert.equal(plan.rollback[0].preconditionRoot, plan.rollbackSnapshotRoot);
  assert.deepEqual(plan.expectedObservation.requiredCheckBindings, [
    { context: "DCO", app_id: 15368 },
    { context: "Source Acceptance", app_id: 15368 },
  ]);
  assert.deepEqual(
    plan.operations[0].body.required_pull_request_reviews.bypass_pull_request_allowances,
    { users: [], teams: [], apps: [] },
  );
  assert.match(plan.planRoot, /^sha256:[0-9a-f]{64}$/);
});

test("rollout plan rejects invalid required-check app bindings", () => {
  assert.throws(() => createGithubGovernanceRolloutPlan({
    repository: "kungfu-systems/buildchain",
    targetRef: "dev/v3/v3.0",
    inventory: {},
    rollbackSnapshot: {},
    desiredProtection: {
      requiredCheckBindings: [{ context: "check", app_id: 0 }],
    },
  }), /positive integer or null/);
});

test("rollout CLI preserves observed check apps and requires explicit new bindings", () => {
  assert.deepEqual(
    resolveRequiredCheckBindings(
      ["check", "Governance receipt"],
      ["Governance receipt=15368"],
      [{ context: "check", app_id: 15368 }],
    ),
    [
      { context: "check", app_id: 15368 },
      { context: "Governance receipt", app_id: 15368 },
    ],
  );
  assert.throws(
    () => resolveRequiredCheckBindings(
      ["check", "Governance receipt"],
      [],
      [{ context: "check", app_id: 15368 }],
    ),
    /must preserve an observed app_id or declare/,
  );
});

test("GitHub API 404 is absence only for read operations", () => {
  const notFound = "gh: Not Found (HTTP 404)";
  assert.equal(githubApiFailureIsAbsence("GET", notFound), true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      githubApiFailureIsAbsence(method, notFound),
      false,
      `${method} 404 must remain a fail-closed mutation error`,
    );
  }
});

test("protection policy plan preserves descriptor-bound and unbound checks", () => {
  assert.deepEqual(
    resolveGithubProtectionTargetPolicy({
      repository: "kungfu-systems/kungfu",
      targetRef: "alpha/v4/v4.0",
    }),
    {
      strictRequiredChecks: true,
      requiredCheckBindings: [
        {
          context: "build / Finalize build controller evidence",
          app_id: 15368,
        },
        { context: "signoff", app_id: 15368 },
        { context: "validate", app_id: 15368 },
      ],
      requiredApprovals: 1,
    },
  );
  assert.deepEqual(
    resolveGithubProtectionTargetPolicy({
      repository: "kungfu-systems/kungfu",
      targetRef: "release/v4/v4.0",
    }),
    {
      strictRequiredChecks: true,
      requiredCheckBindings: [
        { context: "build", app_id: null },
        { context: "signoff", app_id: 15368 },
        { context: "validate", app_id: 15368 },
      ],
      requiredApprovals: 1,
    },
  );
});

test("ruleset authority binds Kungfu Alpha to final build controller evidence", () => {
  const policy = resolveGithubGovernanceTargetPolicy({
    repository: "kungfu-systems/kungfu",
    targetRef: "alpha/v4/v4.0",
  });
  assert.deepEqual(policy.requiredCheckBindings, [
    {
      context: "build / Finalize build controller evidence",
      appId: 15368,
    },
    { context: "signoff", appId: 15368 },
    { context: "validate", appId: 15368 },
  ]);
  assert.equal(policy.strictRequiredChecks, true);
});

test("ruleset authority admits Kungfu stable with exact independent checks", () => {
  assert.deepEqual(
    resolveGithubGovernanceTargetPolicy({
      repository: "kungfu-systems/kungfu",
      targetRef: "release/v4/v4.0",
    }),
    {
      targetRef: "release/v4/v4.0",
      strictRequiredChecks: true,
      requiredCheckBindings: [
        { context: "build", appId: null },
        { context: "signoff", appId: 15368 },
        { context: "validate", appId: 15368 },
      ],
      allowedBypassActors: [
        {
          actorType: "Integration",
          actorId: 15368,
          bypassMode: "always",
        },
      ],
      requiredApprovals: 1,
    },
  );
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

test("ruleset bypass rollout preserves rules and carries an exact inverse", () => {
  const before = normalizeGithubRulesetSnapshot({
    name: "Buildchain dev merge queue: dev/v3/v3.0",
    target: "branch",
    enforcement: "active",
    bypass_actors: [{
      actor_id: 209317,
      actor_type: "User",
      bypass_mode: "always",
    }],
    conditions: {
      ref_name: {
        include: ["refs/heads/dev/v3/v3.0"],
        exclude: [],
      },
    },
    rules: [{
      type: "merge_queue",
      parameters: {
        merge_method: "MERGE",
        max_entries_to_build: 1,
      },
    }],
  });
  const plan = createGithubRulesetBypassRolloutPlan({
    repository: "kungfu-systems/buildchain",
    rulesetId: 19076734,
    inventory: before,
    rollbackSnapshot: before,
  });
  assert.deepEqual(plan.operations[0].body.bypass_actors, []);
  assert.deepEqual(plan.operations[0].body.rules, before.rules);
  assert.deepEqual(plan.rollback[0].body, before);
  assert.equal(plan.rollback[0].preconditionRoot, githubGovernanceDigest(before));
  assert.equal(
    plan.expectedObservation.rulesetRoot,
    githubGovernanceDigest(plan.operations[0].body),
  );
});

test("ruleset policy rollout compiles the exact target descriptor with rollback", () => {
  const targetPolicy = resolveGithubGovernanceTargetPolicy({
    repository: "kungfu-systems/buildchain",
    targetRef: "alpha/v3/v3.0",
  });
  assert.deepEqual(targetPolicy.requiredCheckBindings, [
    { context: "check", appId: 15368 },
    { context: "verify", appId: 15368 },
  ]);
  assert.equal(targetPolicy.strictRequiredChecks, false);
  assert.equal(targetPolicy.requiredApprovals, 1);
  assert.deepEqual(targetPolicy.allowedBypassActors, [{
    actorType: "Integration",
    actorId: 15368,
    bypassMode: "always",
  }]);
  const before = normalizeGithubRulesetSnapshot({
    name: "Buildchain alpha publication authority: alpha/v3/v3.0",
    target: "branch",
    enforcement: "active",
    bypass_actors: [{
      actor_id: 209317,
      actor_type: "User",
      bypass_mode: "always",
    }],
    conditions: {
      ref_name: {
        include: ["refs/heads/alpha/v3/v3.0"],
        exclude: [],
      },
    },
    rules: [
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["merge", "squash", "rebase"],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 1,
          required_review_thread_resolution: true,
          required_reviewers: [],
        },
      },
      { type: "non_fast_forward" },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: [
            { context: "check", integration_id: 15368 },
            { context: "verify", integration_id: 15368 },
          ],
          strict_required_status_checks_policy: true,
        },
      },
    ],
  });
  const plan = createGithubRulesetGovernanceRolloutPlan({
    repository: "kungfu-systems/buildchain",
    targetRef: "alpha/v3/v3.0",
    rulesetId: 19518955,
    inventory: before,
    rollbackSnapshot: before,
    desiredProtection: {
      strictRequiredChecks: targetPolicy.strictRequiredChecks,
      requiredCheckBindings: targetPolicy.requiredCheckBindings,
      requiredApprovals: 1,
      rulesetBypassActors: [],
    },
  });
  assert.deepEqual(plan.operations[0].body.bypass_actors, []);
  assert.deepEqual(
    plan.operations[0].body.rules.find((rule) => rule.type === "pull_request").parameters,
    {
      allowed_merge_methods: ["merge", "squash", "rebase"],
      dismiss_stale_reviews_on_push: true,
      dismissal_restriction: {
        allowed_actors: [],
        enabled: false,
      },
      require_code_owner_review: true,
      require_last_push_approval: true,
      required_approving_review_count: 1,
      required_review_thread_resolution: true,
      required_reviewers: [],
    },
  );
  assert.deepEqual(
    plan.operations[0].body.rules
      .find((rule) => rule.type === "required_status_checks").parameters,
    {
      do_not_enforce_on_create: false,
      required_status_checks: [
        { context: "check", integration_id: 15368 },
        { context: "verify", integration_id: 15368 },
      ],
      strict_required_status_checks_policy: false,
    },
  );
  assert.ok(plan.operations[0].body.rules.some((rule) => rule.type === "non_fast_forward"));
  assert.deepEqual(plan.operations[0].body.rules.map((rule) => rule.type), [
    "pull_request",
    "non_fast_forward",
    "required_status_checks",
  ]);
  assert.deepEqual(plan.rollback[0].body, before);
  assert.equal(plan.rollback[0].preconditionRoot, githubGovernanceDigest(before));
  assert.equal(
    plan.expectedObservation.rulesetRoot,
    githubGovernanceDigest(plan.operations[0].body),
  );

  const mergeQueueOnly = normalizeGithubRulesetSnapshot({
    name: "Buildchain dev merge queue: dev/v3/v3.0",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: ["refs/heads/dev/v3/v3.0"],
        exclude: [],
      },
    },
    rules: [{
      type: "merge_queue",
      parameters: {
        merge_method: "MERGE",
        max_entries_to_build: 1,
      },
    }],
  });
  const canonicalPlan = createGithubRulesetGovernanceRolloutPlan({
    repository: "kungfu-systems/buildchain",
    targetRef: "dev/v3/v3.0",
    rulesetId: 19076734,
    inventory: mergeQueueOnly,
    rollbackSnapshot: mergeQueueOnly,
    desiredProtection: {
      strictRequiredChecks: false,
      requiredCheckBindings: [{ context: "check", appId: 15368 }],
      requiredApprovals: 1,
      rulesetBypassActors: [],
    },
  });
  assert.deepEqual(
    canonicalPlan.operations[0].body.rules
      .find((rule) => rule.type === "pull_request").parameters,
    {
      allowed_merge_methods: ["merge", "squash", "rebase"],
      dismiss_stale_reviews_on_push: true,
      dismissal_restriction: {
        allowed_actors: [],
        enabled: false,
      },
      require_code_owner_review: true,
      require_last_push_approval: true,
      required_approving_review_count: 1,
      required_review_thread_resolution: true,
      required_reviewers: [],
    },
  );
  assert.deepEqual(
    canonicalPlan.operations[0].body.rules
      .find((rule) => rule.type === "required_status_checks").parameters,
    {
      do_not_enforce_on_create: false,
      required_status_checks: [{ context: "check", integration_id: 15368 }],
      strict_required_status_checks_policy: false,
    },
  );

  const installedAppPlan = createGithubRulesetGovernanceRolloutPlan({
    repository: "kungfu-systems/buildchain",
    targetRef: "alpha/v3/v3.0",
    rulesetId: 19518955,
    inventory: before,
    rollbackSnapshot: before,
    desiredProtection: {
      strictRequiredChecks: targetPolicy.strictRequiredChecks,
      requiredCheckBindings: targetPolicy.requiredCheckBindings,
      requiredApprovals: 1,
      rulesetBypassActors: [{
        actorType: "Integration",
        actorId: 4212844,
        bypassMode: "always",
      }],
    },
  });
  assert.deepEqual(installedAppPlan.operations[0].body.bypass_actors, [{
    actor_id: 4212844,
    actor_type: "Integration",
    bypass_mode: "always",
  }]);
  assert.throws(() => createGithubRulesetGovernanceRolloutPlan({
    repository: "kungfu-systems/buildchain",
    targetRef: "release/v2/v2.14",
    rulesetId: 19518955,
    inventory: before,
    rollbackSnapshot: before,
    desiredProtection: {
      requiredCheckBindings: targetPolicy.requiredCheckBindings,
    },
  }), /one exact target branch condition/);
});

test("ruleset policy rollout creates a missing exact target with deletion and force-push protection", () => {
  const targetPolicy = resolveGithubGovernanceTargetPolicy({
    repository: "kungfu-systems/kungfu",
    targetRef: "alpha/v4/v4.0",
  });
  const inventory = {
    repository: "kungfu-systems/kungfu",
    targetRef: "alpha/v4/v4.0",
    matchingRulesets: [],
  };
  const plan = createGithubRulesetGovernanceRolloutPlan({
    repository: "kungfu-systems/kungfu",
    targetRef: "alpha/v4/v4.0",
    rulesetName: "Kungfu Alpha candidate authority: alpha/v4/v4.0",
    inventory,
    rollbackSnapshot: null,
    desiredProtection: {
      strictRequiredChecks: targetPolicy.strictRequiredChecks,
      requiredCheckBindings: targetPolicy.requiredCheckBindings,
      requiredApprovals: 1,
      rulesetBypassActors: [],
      blockDeletions: true,
      blockNonFastForward: true,
    },
  });
  assert.equal(plan.action, "create");
  assert.equal(plan.rulesetId, null);
  assert.equal(plan.operations[0].method, "POST");
  assert.equal(
    plan.operations[0].endpoint,
    "repos/kungfu-systems/kungfu/rulesets",
  );
  assert.deepEqual(plan.operations[0].body.bypass_actors, []);
  assert.deepEqual(
    plan.operations[0].body.conditions.ref_name.include,
    ["refs/heads/alpha/v4/v4.0"],
  );
  assert.deepEqual(
    plan.operations[0].body.rules.map(({ type }) => type).sort(),
    [
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_status_checks",
    ],
  );
  assert.equal(plan.rollback[0].method, "DELETE");
  assert.equal(plan.rollback[0].requiresApplyReceipt, true);
  assert.match(plan.rollback[0].endpoint, /\{ruleset_id\}$/);
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

test("publication authority recollects live App-authenticated governance instead of trusting input JSON", () => {
  const authorityWorkflow = fs.readFileSync(
    new URL("../.github/workflows/.publication-authority.yml", import.meta.url),
    "utf8",
  );
  assert.match(authorityWorkflow, /actions\/create-github-app-token@v3/);
  assert.match(authorityWorkflow, /KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY/);
  assert.match(
    authorityWorkflow,
    /audit-github-governance\.mjs[\s\S]+--repository "\$repository"[\s\S]+--target-ref "\$target_ref"[\s\S]+--require-qualifying/,
  );
  assert.match(authorityWorkflow, /audit\.inventory\?\.targetCount !== 1/);
  assert.doesNotMatch(
    authorityWorkflow,
    /const receipt = JSON\.parse\(serialized\)/,
  );
  assert.match(
    authorityWorkflow,
    /name: Independently verify publication admission[\s\S]+?permissions:\n      actions: read\n      checks: read\n      contents: read\n      pull-requests: read/,
  );
  for (const workflow of [
    ".binary-release-assets.yml",
    ".release-candidate-promote.yml",
    ".web-surface.yml",
    "paper-release.yml",
    "paper-release-sealed.yml",
  ]) {
    const source = fs.readFileSync(
      new URL(`../.github/workflows/${workflow}`, import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /permissions:\n      actions: read\n      checks: read\n      contents: read\n      pull-requests: read\n    uses: \.\/\.github\/workflows\/\.publication-authority\.yml/,
      workflow,
    );
  }
  for (const workflow of [
    ".release-candidate-promote.yml",
    "paper-release.yml",
    "paper-release-sealed.yml",
  ]) {
    const source = fs.readFileSync(
      new URL(`../.github/workflows/${workflow}`, import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /uses: \.\/\.github\/workflows\/\.publication-authority\.yml[\s\S]+?secrets: inherit/,
      workflow,
    );
  }
});
