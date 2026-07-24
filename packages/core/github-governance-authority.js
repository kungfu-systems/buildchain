import crypto from "node:crypto";

export const GITHUB_GOVERNANCE_AUTHORITY_CONTRACT =
  "kungfu-buildchain-github-governance-authority";
export const GITHUB_GOVERNANCE_RECEIPT_CONTRACT =
  "kungfu-buildchain-github-governance-receipt";
export const GITHUB_GOVERNANCE_ROLLOUT_CONTRACT =
  "kungfu-buildchain-github-governance-rollout-plan";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PUBLIC_REPOSITORIES = Object.freeze([
  "agent-hub-demo",
  "build-images",
  "buildchain",
  "homebrew-tap",
  "kfd",
  "kungfu",
  "libnode",
  "paper-episodes-to-primitives",
  "paper-kfd-foundation-real-world-agent-work",
  "paper-kungfu-product-white-paper",
  "paper-observer-declared-timelines",
  "site-kungfu-tech",
  "site-libkungfu-dev",
]);
const PROTECTED_AUTHORITY_PATHS = Object.freeze([
  ".github/CODEOWNERS",
  ".github/workflows/.publication-authority.yml",
  ".github/workflows/github-governance-audit.yml",
  "packages/core/github-governance-authority.js",
  "scripts/audit-github-governance.mjs",
  "scripts/reconcile-github-governance.mjs",
]);
const REQUIRED_FACTS = Object.freeze([
  "api-evidence",
  "repository-admission",
  "plan-capability",
  "codeowners-source",
  "codeowners-authority",
  "native-protection",
  "independent-review",
  "fresh-review",
  "administrator-enforcement",
  "bypass-policy",
  "conversation-resolution",
  "required-checks",
  "ref-integrity",
  "development-least-privilege",
  "review-authority",
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function githubGovernanceDigest(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function requiredRoot(value, label) {
  const normalized = requiredString(value, label);
  if (!SHA256.test(normalized)) throw new Error(`${label} must be a sha256 root`);
  return normalized;
}

function normalizedRef(value) {
  return requiredString(value, "target ref").replace(/^refs\/heads\//, "");
}

function normalizeLogin(value) {
  return requiredString(value, "GitHub login").replace(/^@/, "").toLowerCase();
}

function normalizeRulePath(value) {
  return String(value || "").trim().replace(/^\/+/, "");
}

function matchesRef(pattern, branch, defaultBranch) {
  const normalized = String(pattern || "");
  const ref = `refs/heads/${branch}`;
  if (normalized === "~DEFAULT_BRANCH") return branch === defaultBranch;
  if (normalized === branch || normalized === ref) return true;
  if (!normalized.includes("*")) return false;
  const expression = new RegExp(
    `^${normalized
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return expression.test(ref) || expression.test(branch);
}

function applicableRulesets(rulesets, branch, defaultBranch) {
  return (rulesets || []).filter((ruleset) => {
    if (ruleset?.enforcement !== "active" || ruleset?.target !== "branch") return false;
    const include = ruleset.conditions?.ref_name?.include || [];
    const exclude = ruleset.conditions?.ref_name?.exclude || [];
    return include.some((pattern) => matchesRef(pattern, branch, defaultBranch)) &&
      !exclude.some((pattern) => matchesRef(pattern, branch, defaultBranch));
  });
}

function ruleParameters(rulesets, type) {
  return rulesets
    .flatMap((ruleset) => ruleset.rules || [])
    .filter((rule) => rule?.type === type)
    .map((rule) => rule.parameters || {});
}

function protectionChecks(protection) {
  const status = protection?.required_status_checks || {};
  const checks = [
    ...(status.checks || []).map((entry) => String(entry?.context || "").trim()),
    ...(status.contexts || []).map((entry) => String(entry || "").trim()),
  ].filter(Boolean);
  return [...new Set(checks)].sort();
}

function rulesetChecks(rulesets) {
  return [...new Set(ruleParameters(rulesets, "required_status_checks")
    .flatMap((parameters) => parameters.required_status_checks || [])
    .map((entry) => String(entry?.context || "").trim())
    .filter(Boolean))].sort();
}

export function compileEffectiveGithubGovernancePolicy({
  branch,
  defaultBranch,
  protectedBranch = false,
  protection,
  rulesets = [],
} = {}) {
  const target = normalizedRef(branch);
  const applicable = applicableRulesets(rulesets, target, defaultBranch);
  const pullRequests = ruleParameters(applicable, "pull_request");
  const classicReview = protection?.required_pull_request_reviews || {};
  const requiredChecks = [...new Set([
    ...protectionChecks(protection),
    ...rulesetChecks(applicable),
  ])].sort();
  const bypassActors = applicable.flatMap((ruleset) => ruleset.bypass_actors || []);
  const classicProtected = Boolean(protection);
  const rulesetPullRequest = pullRequests.length > 0;
  const requiredApprovals = Math.max(
    Number(classicReview.required_approving_review_count || 0),
    ...pullRequests.map((policy) => Number(policy.required_approving_review_count || 0)),
  );
  const codeOwnerReviewRequired = classicReview.require_code_owner_reviews === true ||
    pullRequests.some((policy) => policy.require_code_owner_review === true);
  const dismissStaleReviews = classicReview.dismiss_stale_reviews === true ||
    pullRequests.some((policy) => policy.dismiss_stale_reviews_on_push === true);
  const requireLastPushApproval = classicReview.require_last_push_approval === true ||
    pullRequests.some((policy) => policy.require_last_push_approval === true);
  const conversationResolution = protection?.required_conversation_resolution?.enabled === true ||
    pullRequests.some((policy) => policy.required_review_thread_resolution === true);
  const enforceAdmins = classicProtected
    ? protection?.enforce_admins?.enabled === true
    : bypassActors.every((actor) => actor?.actor_type !== "OrganizationAdmin");
  const allowForcePushes = classicProtected
    ? protection?.allow_force_pushes?.enabled === true
    : !applicable.some((ruleset) => (ruleset.rules || []).some((rule) => rule?.type === "non_fast_forward"));
  const allowDeletions = classicProtected
    ? protection?.allow_deletions?.enabled === true
    : !applicable.some((ruleset) => (ruleset.rules || []).some((rule) => rule?.type === "deletion"));
  return {
    targetRef: target,
    protected: protectedBranch === true || classicProtected || applicable.length > 0,
    nativePullRequestRequired: classicReview.required_approving_review_count !== undefined ||
      rulesetPullRequest,
    requiredApprovals,
    codeOwnerReviewRequired,
    dismissStaleReviews,
    requireLastPushApproval,
    conversationResolution,
    requiredChecks,
    strictRequiredChecks: protection?.required_status_checks?.strict === true ||
      ruleParameters(applicable, "required_status_checks")
        .some((policy) => policy.strict_required_status_checks_policy === true),
    enforceAdmins,
    bypassActors: bypassActors.map((actor) => ({
      actorType: String(actor?.actor_type || ""),
      bypassMode: String(actor?.bypass_mode || ""),
      actorId: Number(actor?.actor_id || 0),
    })),
    allowForcePushes,
    allowDeletions,
    classicProtectionObserved: classicProtected,
    applicableRulesetRoots: applicable.map((ruleset) => githubGovernanceDigest(ruleset)).sort(),
  };
}

function codeownersPatternMatches(pattern, candidatePath) {
  let normalized = normalizeRulePath(pattern);
  if (!normalized || normalized.startsWith("!")) return false;
  const candidate = normalizeRulePath(candidatePath);
  if (!normalized.includes("/")) normalized = `**/${normalized}`;
  if (normalized.endsWith("/")) normalized += "**";
  const expression = normalized
    .split("**")
    .map((part) => part
      .split("*")
      .map((token) => token.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(candidate) ||
    new RegExp(`^${expression.replace(/^\.\*\//, "(?:.*/)?")}$`).test(candidate);
}

export function parseCodeowners(source) {
  const rules = [];
  for (const [index, line] of String(source || "").split(/\r?\n/).entries()) {
    const stripped = line.replace(/(^|[^\\])#.*/, "$1").trim();
    if (!stripped) continue;
    const [pattern, ...owners] = stripped.split(/\s+/);
    if (!pattern || owners.length === 0) continue;
    rules.push({
      line: index + 1,
      pattern,
      owners: owners.map((owner) => owner.toLowerCase()),
    });
  }
  return rules;
}

export function codeownersForPath(source, candidatePath) {
  let owners = [];
  for (const rule of parseCodeowners(source)) {
    if (codeownersPatternMatches(rule.pattern, candidatePath)) owners = rule.owners;
  }
  return owners;
}

export function evaluateCodeownersAuthority({
  source = "",
  sourcePath = "",
  reviewAuthority = "kungfu-origin",
  protectedPaths = PROTECTED_AUTHORITY_PATHS,
} = {}) {
  const authority = `@${normalizeLogin(reviewAuthority)}`;
  const pathOwners = Object.fromEntries(
    protectedPaths.map((candidatePath) => [
      candidatePath,
      codeownersForPath(source, candidatePath),
    ]),
  );
  return {
    exists: Boolean(String(source)),
    sourcePath: normalizeRulePath(sourcePath),
    sourceDigest: String(source) ? githubGovernanceDigest(String(source)) : "",
    reviewAuthority: authority,
    protectedPaths: [...protectedPaths],
    pathOwners,
    allProtectedPathsOwned: protectedPaths.every((candidatePath) =>
      pathOwners[candidatePath].includes(authority)),
  };
}

export function createBuildchainGithubGovernanceAuthority() {
  const descriptor = {
    schemaVersion: 1,
    contract: GITHUB_GOVERNANCE_AUTHORITY_CONTRACT,
    organization: "kungfu-systems",
    authority: {
      developmentIdentity: "dongkeren",
      reviewIdentity: "kungfu-origin",
      minimumIndependentApprovals: 1,
      protectedAuthorityPaths: [...PROTECTED_AUTHORITY_PATHS],
    },
    trustedComputingBase: {
      trusted: [
        "GitHub service integrity and authenticated API state",
        "retained organization-owner recovery custody",
        "kungfu-origin review and governance identity",
        "Buildchain verifier source and exact runtime identity",
        "official publication identity configuration",
      ],
      nonClaims: [
        "GitHub platform compromise is outside this authority guarantee",
        "compromise of all retained owner and recovery anchors is outside this authority guarantee",
        "a qualifying receipt is not a bearer credential and grants no GitHub permission",
      ],
    },
    repositoryAdmission: {
      publicRepositories: [...PUBLIC_REPOSITORIES],
      privateRepositoryPolicy: "non-authoritative-until-plan-capability-qualifies",
      unknownRepositoryPolicy: "non-authoritative-until-explicit-admission",
      baseline: {
        observedOn: "2026-07-24",
        repositoryCount: 16,
        publicCount: 13,
        privateCount: 3,
      },
    },
    planCapability: {
      publicRepositories: ["free", "team", "enterprise"],
      privateRepositories: ["team", "enterprise"],
      organizationRulesets: ["team", "enterprise"],
    },
    effectivePolicy: {
      codeOwnerReviewRequired: true,
      minimumIndependentApprovals: 1,
      freshApprovalAfterLatestPush: true,
      administratorEnforcement: true,
      allowedBypassActors: [],
      conversationResolution: true,
      requiredChecks: "non-empty",
      forcePush: false,
      deletion: false,
      nativeEnforcementRequired: true,
    },
    breakGlass: {
      default: "disabled",
      requirements: [
        "separately authenticated",
        "reason-bound",
        "time-bounded",
        "independently receipted",
        "mandatory restoration and root comparison",
      ],
    },
  };
  return {
    ...descriptor,
    policyRoot: githubGovernanceDigest(descriptor),
  };
}

function repositoryAdmission(descriptor, repository) {
  const [owner, name] = requiredString(repository.fullName, "repository full name").split("/");
  if (owner !== descriptor.organization) return "non-authoritative-foreign-owner";
  if (repository.visibility === "private") {
    return repository.admitted === true
      ? "admitted-private"
      : "non-authoritative-explicit-admission-required";
  }
  return descriptor.repositoryAdmission.publicRepositories.includes(name)
    ? "admitted-public"
    : "non-authoritative-explicit-admission-required";
}

function planCapability(descriptor, repository, planName) {
  const normalizedPlan = String(planName || "").toLowerCase();
  const allowed = repository.visibility === "private"
    ? descriptor.planCapability.privateRepositories
    : descriptor.planCapability.publicRepositories;
  return {
    plan: normalizedPlan || "unknown",
    requiredCapability: repository.visibility === "private"
      ? "private-repository-native-protection"
      : "public-repository-native-protection",
    qualifying: allowed.includes(normalizedPlan),
  };
}

function fact(id, pass, observed) {
  return {
    id,
    status: pass ? "pass" : "fail",
    evidenceRoot: githubGovernanceDigest({ id, observed }),
  };
}

function sanitizedRepositoryIdentity(repository) {
  if (repository.visibility === "private") {
    return {
      visibility: "private",
      repository: null,
      repositoryIdentityRoot: requiredRoot(
        repository.identityRoot || githubGovernanceDigest(repository.fullName),
        "private repository identity root",
      ),
    };
  }
  return {
    visibility: "public",
    repository: requiredString(repository.fullName, "repository full name"),
    repositoryIdentityRoot: githubGovernanceDigest(repository.fullName),
  };
}

export function evaluateGithubGovernanceSnapshot({
  descriptor = createBuildchainGithubGovernanceAuthority(),
  repository,
  targetRef,
  organizationPlan,
  codeowners,
  effectivePolicy,
  memberships,
  apiEvidence = {},
  observedAt,
  expiresAt,
  verifier = {},
} = {}) {
  const { policyRoot, ...descriptorCore } = descriptor;
  if (policyRoot !== githubGovernanceDigest(descriptorCore)) {
    throw new Error("GitHub governance authority policy root mismatch");
  }
  const identity = sanitizedRepositoryIdentity(repository || {});
  const admission = repositoryAdmission(descriptor, repository || {});
  const capability = planCapability(descriptor, repository || {}, organizationPlan);
  const policy = effectivePolicy || {};
  const ownership = codeowners || {};
  const developmentLogin = normalizeLogin(descriptor.authority.developmentIdentity);
  const reviewLogin = normalizeLogin(descriptor.authority.reviewIdentity);
  const development = memberships?.[developmentLogin] || {};
  const review = memberships?.[reviewLogin] || {};
  const apiPass = apiEvidence.complete === true &&
    apiEvidence.readable === true &&
    apiEvidence.ambiguous !== true;
  const admitted = admission === "admitted-public" ||
    admission === "admitted-private";
  const facts = [
    fact("api-evidence", apiPass, apiEvidence),
    fact("repository-admission", admitted, { admission, visibility: repository?.visibility }),
    fact("plan-capability", capability.qualifying, capability),
    fact("codeowners-source", ownership.exists === true && SHA256.test(ownership.sourceDigest || ""), {
      exists: ownership.exists,
      sourcePath: ownership.sourcePath,
      sourceDigest: ownership.sourceDigest,
    }),
    fact("codeowners-authority", ownership.allProtectedPathsOwned === true, {
      reviewAuthority: ownership.reviewAuthority,
      protectedPaths: ownership.protectedPaths,
      pathOwners: ownership.pathOwners,
    }),
    fact("native-protection", policy.protected === true && policy.nativePullRequestRequired === true, {
      protected: policy.protected,
      nativePullRequestRequired: policy.nativePullRequestRequired,
    }),
    fact("independent-review",
      policy.codeOwnerReviewRequired === true &&
        Number(policy.requiredApprovals || 0) >= descriptor.authority.minimumIndependentApprovals,
      {
        codeOwnerReviewRequired: policy.codeOwnerReviewRequired,
        requiredApprovals: policy.requiredApprovals,
      }),
    fact("fresh-review",
      policy.dismissStaleReviews === true || policy.requireLastPushApproval === true,
      {
        dismissStaleReviews: policy.dismissStaleReviews,
        requireLastPushApproval: policy.requireLastPushApproval,
      }),
    fact("administrator-enforcement", policy.enforceAdmins === true, {
      enforceAdmins: policy.enforceAdmins,
    }),
    fact("bypass-policy", Array.isArray(policy.bypassActors) && policy.bypassActors.length === 0, {
      bypassActors: policy.bypassActors || [],
    }),
    fact("conversation-resolution", policy.conversationResolution === true, {
      conversationResolution: policy.conversationResolution,
    }),
    fact("required-checks", Array.isArray(policy.requiredChecks) && policy.requiredChecks.length > 0, {
      requiredChecks: policy.requiredChecks || [],
    }),
    fact("ref-integrity", policy.allowForcePushes === false && policy.allowDeletions === false, {
      allowForcePushes: policy.allowForcePushes,
      allowDeletions: policy.allowDeletions,
    }),
    fact("development-least-privilege",
      development.state === "active" && !["admin", "maintain"].includes(development.role),
      { state: development.state, roleClass: development.role }),
    fact("review-authority",
      review.state === "active" && ["admin", "maintain"].includes(review.role),
      { state: review.state, roleClass: review.role }),
  ];
  const qualifying = REQUIRED_FACTS.every((id) =>
    facts.some((entry) => entry.id === id && entry.status === "pass"));
  const core = {
    schemaVersion: 1,
    contract: GITHUB_GOVERNANCE_RECEIPT_CONTRACT,
    status: qualifying ? "qualifying" : "non-qualifying",
    qualifying,
    organization: descriptor.organization,
    ...identity,
    targetRef: normalizedRef(targetRef),
    policyRoot: descriptor.policyRoot,
    codeownersDigest: ownership.sourceDigest || "",
    effectiveRuleRoots: [
      ...(policy.applicableRulesetRoots || []),
      ...(policy.classicProtectionObserved
        ? [githubGovernanceDigest({
            targetRef: policy.targetRef,
            classicProtectionObserved: true,
            requiredChecks: policy.requiredChecks,
          })]
        : []),
    ].sort(),
    membershipAuthorityRoot: githubGovernanceDigest({
      development: { state: development.state || "", roleClass: development.role || "" },
      review: { state: review.state || "", roleClass: review.role || "" },
    }),
    requiredChecks: [...(policy.requiredChecks || [])].sort(),
    admission,
    planCapability: capability,
    apiEvidence: {
      status: apiPass ? "complete" : "non-qualifying",
      evidenceRoot: githubGovernanceDigest(apiEvidence),
    },
    verifier: {
      runtime: requiredString(verifier.runtime, "verifier runtime"),
      sourceRevision: requiredString(verifier.sourceRevision, "verifier source revision"),
      identityRoot: requiredRoot(verifier.identityRoot, "verifier identity root"),
    },
    observedAt: requiredString(observedAt, "observedAt"),
    expiresAt: requiredString(expiresAt, "expiresAt"),
    facts,
    failureIds: facts.filter((entry) => entry.status === "fail").map((entry) => entry.id),
    nonClaims: [...descriptor.trustedComputingBase.nonClaims],
  };
  return { ...core, receiptRoot: githubGovernanceDigest(core) };
}

export function verifyGithubGovernanceReceipt(receipt, {
  expectedOrganization,
  expectedRepository,
  expectedRepositoryIdentityRoot,
  expectedTargetRef,
  expectedPolicyRoot,
  expectedVerifierSourceRevision,
  now = new Date().toISOString(),
} = {}) {
  if (receipt?.contract !== GITHUB_GOVERNANCE_RECEIPT_CONTRACT) {
    throw new Error("GitHub governance receipt contract mismatch");
  }
  const { receiptRoot, ...core } = receipt;
  if (receiptRoot !== githubGovernanceDigest(core)) {
    throw new Error("GitHub governance receipt root mismatch");
  }
  if (receipt.qualifying !== true || receipt.status !== "qualifying" || receipt.failureIds?.length) {
    throw new Error("GitHub governance receipt is non-qualifying");
  }
  if (expectedOrganization && receipt.organization !== expectedOrganization) {
    throw new Error("GitHub governance receipt organization mismatch");
  }
  if (expectedRepository && receipt.repository !== expectedRepository) {
    throw new Error("GitHub governance receipt repository mismatch");
  }
  if (expectedRepositoryIdentityRoot &&
      receipt.repositoryIdentityRoot !== expectedRepositoryIdentityRoot) {
    throw new Error("GitHub governance receipt repository identity mismatch");
  }
  if (expectedTargetRef && receipt.targetRef !== normalizedRef(expectedTargetRef)) {
    throw new Error("GitHub governance receipt target ref mismatch");
  }
  if (expectedPolicyRoot && receipt.policyRoot !== expectedPolicyRoot) {
    throw new Error("GitHub governance receipt policy root mismatch");
  }
  if (expectedVerifierSourceRevision &&
      receipt.verifier?.sourceRevision !== expectedVerifierSourceRevision) {
    throw new Error("GitHub governance receipt verifier source revision mismatch");
  }
  const observed = Date.parse(receipt.observedAt);
  const expires = Date.parse(receipt.expiresAt);
  const instant = Date.parse(now);
  if (![observed, expires, instant].every(Number.isFinite) || observed > instant || expires <= instant) {
    throw new Error("GitHub governance receipt freshness is invalid");
  }
  return receipt;
}

export function createGithubGovernanceRolloutPlan({
  repository,
  targetRef,
  inventory,
  rollbackSnapshot,
  rollbackProtectionExists = true,
  desiredProtection,
} = {}) {
  const fullName = requiredString(repository, "repository");
  const branch = normalizedRef(targetRef);
  if (!inventory || !rollbackSnapshot) {
    throw new Error("read-only inventory and frozen rollback snapshot are required");
  }
  const inventoryRoot = githubGovernanceDigest(inventory);
  const rollbackSnapshotRoot = githubGovernanceDigest(rollbackSnapshot);
  const requiredCheckBindings = (desiredProtection?.requiredCheckBindings ||
    desiredProtection?.requiredChecks || []).map((entry) => {
    const context = requiredString(
      typeof entry === "string" ? entry : entry?.context,
      "required check context",
    );
    const appId = typeof entry === "string" ? null : entry?.app_id;
    if (appId !== null && (!Number.isInteger(appId) || appId <= 0)) {
      throw new Error(`required check app_id must be a positive integer or null: ${context}`);
    }
    return { context, app_id: appId ?? null };
  });
  const body = {
    required_status_checks: {
      strict: desiredProtection?.strictRequiredChecks === true,
      checks: requiredCheckBindings,
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      required_approving_review_count: Math.max(
        1,
        Number(desiredProtection?.requiredApprovals || 1),
      ),
      require_last_push_approval: true,
    },
    restrictions: null,
    required_conversation_resolution: true,
    allow_force_pushes: false,
    allow_deletions: false,
  };
  const endpoint = `repos/${fullName}/branches/${encodeURIComponent(branch)}/protection`;
  const core = {
    schemaVersion: 1,
    contract: GITHUB_GOVERNANCE_ROLLOUT_CONTRACT,
    repository: fullName,
    targetRef: branch,
    inventoryRoot,
    rollbackSnapshotRoot,
    operations: [{ method: "PUT", endpoint, body }],
    impact: [
      "require pull requests and a fresh Code Owner approval",
      "enforce required checks and resolved conversations for administrators",
      "deny force pushes and protected-branch deletion",
    ],
    expectedObservation: {
      codeOwnerReviewRequired: true,
      requiredApprovals: body.required_pull_request_reviews.required_approving_review_count,
      dismissStaleReviews: true,
      requireLastPushApproval: true,
      enforceAdmins: true,
      requiredChecks: body.required_status_checks.checks.map((entry) => entry.context),
      requiredCheckBindings: body.required_status_checks.checks,
      allowForcePushes: false,
      allowDeletions: false,
    },
    rollback: [{
      method: rollbackProtectionExists ? "PUT" : "DELETE",
      endpoint,
      body: rollbackProtectionExists ? rollbackSnapshot : null,
      preconditionRoot: rollbackSnapshotRoot,
    }],
  };
  return { ...core, planRoot: githubGovernanceDigest(core) };
}

export function normalizeGithubBranchProtectionSnapshot(protection = {}) {
  const providerChecks = protection.required_status_checks?.checks || [];
  const checks = providerChecks.length > 0
    ? providerChecks.map((entry) => ({
      context: requiredString(entry?.context, "required check context"),
      app_id: entry?.app_id ?? null,
    }))
    : (protection.required_status_checks?.contexts || []).map((context) => ({
        context: requiredString(context, "required check context"),
        app_id: null,
      }));
  const uniqueChecks = [];
  for (const check of checks) {
    if (!uniqueChecks.some((entry) =>
      entry.context === check.context && entry.app_id === check.app_id)) {
      uniqueChecks.push(check);
    }
  }
  const actors = (value, key) => (value?.[key] || [])
    .map((entry) => String(entry?.login || entry?.slug || entry?.name || "").trim())
    .filter(Boolean)
    .sort();
  const restrictions = protection.restrictions;
  const review = protection.required_pull_request_reviews;
  const allowance = review?.bypass_pull_request_allowances;
  const dismissals = review?.dismissal_restrictions;
  return {
    required_status_checks: protection.required_status_checks
      ? {
          strict: protection.required_status_checks.strict === true,
          checks: uniqueChecks,
        }
      : null,
    enforce_admins: protection.enforce_admins?.enabled === true,
    required_pull_request_reviews: review
      ? {
          dismissal_restrictions: {
            users: actors(dismissals, "users"),
            teams: actors(dismissals, "teams"),
            apps: actors(dismissals, "apps"),
          },
          dismiss_stale_reviews: review.dismiss_stale_reviews === true,
          require_code_owner_reviews: review.require_code_owner_reviews === true,
          required_approving_review_count: Number(review.required_approving_review_count || 0),
          require_last_push_approval: review.require_last_push_approval === true,
          bypass_pull_request_allowances: {
            users: actors(allowance, "users"),
            teams: actors(allowance, "teams"),
            apps: actors(allowance, "apps"),
          },
        }
      : null,
    restrictions: restrictions
      ? {
          users: actors(restrictions, "users"),
          teams: actors(restrictions, "teams"),
          apps: actors(restrictions, "apps"),
        }
      : null,
    required_linear_history: protection.required_linear_history?.enabled === true,
    allow_force_pushes: protection.allow_force_pushes?.enabled === true,
    allow_deletions: protection.allow_deletions?.enabled === true,
    block_creations: protection.block_creations?.enabled === true,
    required_conversation_resolution:
      protection.required_conversation_resolution?.enabled === true,
    lock_branch: protection.lock_branch?.enabled === true,
    allow_fork_syncing: protection.allow_fork_syncing?.enabled === true,
  };
}

export const BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY =
  Object.freeze(createBuildchainGithubGovernanceAuthority());
export const BUILDCHAIN_GITHUB_GOVERNANCE_PROTECTED_PATHS =
  PROTECTED_AUTHORITY_PATHS;
