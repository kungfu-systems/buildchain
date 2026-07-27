import crypto from "node:crypto";

export const GITHUB_GOVERNANCE_AUTHORITY_CONTRACT =
  "kungfu-buildchain-github-governance-authority";
export const GITHUB_GOVERNANCE_RECEIPT_CONTRACT =
  "kungfu-buildchain-github-governance-receipt";
export const GITHUB_GOVERNANCE_ROLLOUT_CONTRACT =
  "kungfu-buildchain-github-governance-rollout-plan";
export const GITHUB_GOVERNANCE_RULESET_ROLLOUT_CONTRACT =
  "kungfu-buildchain-github-governance-ruleset-rollout-plan";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GITHUB_ACTIONS_APP_ID = 15368;
const GITHUB_ACTIONS_BYPASS_ACTOR = Object.freeze({
  actorType: "Integration",
  actorId: GITHUB_ACTIONS_APP_ID,
  bypassMode: "always",
});
const check = (context, appId = GITHUB_ACTIONS_APP_ID) => ({
  context,
  appId,
});
const target = (
  targetRef,
  requiredCheckBindings,
  strictRequiredChecks,
  allowedBypassActors = /^(dev|alpha|release)\//.test(targetRef)
    ? [GITHUB_ACTIONS_BYPASS_ACTOR]
    : [],
) => ({
  targetRef,
  requiredCheckBindings,
  strictRequiredChecks,
  allowedBypassActors,
});
const PUBLIC_REPOSITORY_TARGETS = Object.freeze({
  "agent-hub-demo": [
    target("dev/v0/v0.2", [check("check / check")], true),
    target("alpha/v0/v0.2", [check("check / check")], false),
    target("release/v0/v0.2", [check("check / check")], false),
  ],
  "build-images": [
    target("dev/v1/v1.1", [check("check")], true),
    target("alpha/v1/v1.1", [check("check")], true),
    target("release/v1/v1.1", [check("check")], true),
    target("publish-gate/major", [check("check")], true),
  ],
  buildchain: [
    target("dev/v3/v3.0", [check("check")], false),
    target("alpha/v3/v3.0", [check("check"), check("verify")], false),
    target("release/v3/v3.0", [check("check")], true),
    target("publish-gate/major", [check("check")], true),
  ],
  "homebrew-tap": [
    target("main", [check("check / Finalize channel router controller evidence")], false),
  ],
  kfd: [
    target("dev/v1/v1.0", [check("check / check")], true),
    target("alpha/v1/v1.0", [check("check / check")], true),
  ],
  kungfu: [
    target("dev/v4/v4.0", [check("affected-native / linux")], false),
    target("alpha/v4/v4.0", [
      check("build", null),
      check("signoff"),
      check("validate"),
    ], true),
    target("release/v4/v4.0", [
      check("build", null),
      check("signoff"),
      check("validate"),
    ], true),
  ],
  libnode: [
    target("dev/v22/v22.22", [check("build")], true),
    target("alpha/v22/v22.22", [check("build")], true),
    target(
      "release/v22/v22.22",
      [check("build / Build with resolved channel / Summarize build contract")],
      true,
    ),
  ],
  "paper-episodes-to-primitives": [
    target("main", [check("governance")], false),
    target("dev/v0/v0.1", [check("check / check")], true),
    target("alpha/v0/v0.1", [check("check / check")], true),
  ],
  "paper-kfd-foundation-real-world-agent-work": [
    target("main", [check("check / check")], false),
    target("dev/v0/v0.1", [check("check / check")], true),
    target("alpha/v0/v0.1", [check("check / check")], true),
  ],
  "paper-kungfu-product-white-paper": [
    target("main", [check("check / check")], false),
    target("dev/v0/v0.1", [check("check / check")], true),
    target("alpha/v0/v0.1", [check("check / check")], true),
  ],
  "paper-observer-declared-timelines": [
    target("main", [check("check / check")], false),
    target("dev/v0/v0.1", [check("check / check")], true),
    target("alpha/v0/v0.1", [check("check / check")], true),
  ],
  "site-kungfu-tech": [
    target("main", [check("web-surface / Record web-surface controller receipt")], false),
  ],
  "site-libkungfu-dev": [
    target("main", [check("web-surface / Record web-surface controller receipt")], false),
  ],
});
const PUBLIC_REPOSITORIES = Object.freeze(Object.keys(PUBLIC_REPOSITORY_TARGETS).sort());
const PRIVATE_REPOSITORY_IDENTITIES = Object.freeze([
  "sha256:581823ab841e1d9a9025c92d0c47b164c6aaa1ea22112fdbc8d73bd2c862a05f",
  "sha256:b7255e01d10000eb3a2786456b4c558178675ccb6cf28a6e39a74dbfe918df35",
  "sha256:f41bd767e9c4a0ab429ca2a2f456d29ddefab0e996d75000ba36334689eb177e",
]);
const PROTECTED_AUTHORITY_PATHS = Object.freeze([
  ".github/CODEOWNERS",
  ".github/workflows/.publication-authority.yml",
  ".github/workflows/.release-candidate-promote.yml",
  ".github/workflows/buildchain-ref-promotion.yml",
  ".github/workflows/github-governance-audit.yml",
  ".github/workflows/paper-release-sealed.yml",
  ".github/workflows/paper-release.yml",
  ".github/workflows/release-line-bootstrap.yml",
  ".github/workflows/release-candidate-promote.yml",
  "actions/promote-buildchain-ref/action.yml",
  "actions/promote-buildchain-ref/dist/index.js",
  "actions/promote-buildchain-ref/index.js",
  "actions/promote-buildchain-ref/lib.js",
  "packages/core/github-governance-authority.js",
  "packages/core/buildchain-publication-authority.js",
  "scripts/audit-github-governance.mjs",
  "scripts/reconcile-github-governance.mjs",
]);
const REQUIRED_FACTS = Object.freeze([
  "api-evidence",
  "repository-admission",
  "target-ref-admission",
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
  "strict-required-checks",
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

function normalizeCheckBinding(entry) {
  const context = String(
    typeof entry === "string" ? entry : entry?.context || "",
  ).trim();
  if (!context) return null;
  const providerAppId = typeof entry === "string"
    ? null
    : entry?.app_id ?? entry?.integration_id ?? null;
  return {
    context,
    appId: Number.isInteger(providerAppId) && providerAppId > 0
      ? providerAppId
      : null,
  };
}

function uniqueCheckBindings(bindings) {
  return bindings
    .filter(Boolean)
    .filter((binding, index, values) =>
      values.findIndex((candidate) =>
        candidate.context === binding.context &&
        candidate.appId === binding.appId) === index)
    .sort((left, right) =>
      `${left.context}:${left.appId ?? ""}`.localeCompare(
        `${right.context}:${right.appId ?? ""}`,
      ));
}

function uniqueBypassActors(actors) {
  return (actors || [])
    .map((actor) => ({
      actorType: String(actor?.actorType || ""),
      actorId: Number(actor?.actorId || 0),
      bypassMode: String(actor?.bypassMode || ""),
    }))
    .filter((actor) =>
      actor.actorType &&
      Number.isInteger(actor.actorId) &&
      actor.actorId > 0 &&
      actor.bypassMode)
    .filter((actor, index, values) =>
      values.findIndex((candidate) =>
        candidate.actorType === actor.actorType &&
        candidate.actorId === actor.actorId &&
        candidate.bypassMode === actor.bypassMode) === index)
    .sort((left, right) =>
      `${left.actorType}:${left.actorId}:${left.bypassMode}`.localeCompare(
        `${right.actorType}:${right.actorId}:${right.bypassMode}`,
      ));
}

function protectionCheckBindings(protection) {
  const status = protection?.required_status_checks || {};
  const checks = Array.isArray(status.checks) ? status.checks : [];
  return uniqueCheckBindings(
    (checks.length > 0 ? checks : status.contexts || [])
      .map(normalizeCheckBinding),
  );
}

function rulesetCheckBindings(rulesets) {
  return uniqueCheckBindings(ruleParameters(rulesets, "required_status_checks")
    .flatMap((parameters) => parameters.required_status_checks || [])
    .map(normalizeCheckBinding));
}

function classicBypassActors(review = {}) {
  const allowances = review.bypass_pull_request_allowances || {};
  return [
    ...(allowances.users || []).map((actor) => ({
      actor_type: "User",
      bypass_mode: "always",
      actor_id: Number(actor?.id || 0),
    })),
    ...(allowances.teams || []).map((actor) => ({
      actor_type: "Team",
      bypass_mode: "always",
      actor_id: Number(actor?.id || 0),
    })),
    ...(allowances.apps || []).map((actor) => ({
      actor_type: "Integration",
      bypass_mode: "always",
      actor_id: Number(actor?.id || 0),
    })),
  ];
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
  const requiredCheckBindings = uniqueCheckBindings([
    ...protectionCheckBindings(protection),
    ...rulesetCheckBindings(applicable),
  ]);
  const requiredChecks = [...new Set(
    requiredCheckBindings.map((entry) => entry.context),
  )].sort();
  const bypassActors = [
    ...classicBypassActors(classicReview),
    ...applicable.flatMap((ruleset) => ruleset.bypass_actors || []),
  ];
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
    requiredCheckBindings,
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
      publicAuthoritativeTargets: Object.fromEntries(
        Object.entries(PUBLIC_REPOSITORY_TARGETS).map(([repository, targets]) => [
          repository,
          targets.map((entry) => ({
            targetRef: entry.targetRef,
            requiredCheckBindings: entry.requiredCheckBindings.map((binding) => ({
              ...binding,
            })),
            strictRequiredChecks: entry.strictRequiredChecks,
            allowedBypassActors: entry.allowedBypassActors.map((actor) => ({
              ...actor,
            })),
          })),
        ]),
      ),
      privateRepositoryIdentities: PRIVATE_REPOSITORY_IDENTITIES.map((identityRoot) => ({
        identityRoot,
        targetPolicy: "default-and-current-version-line",
        requiredCheckPolicies: {},
      })),
      privateRepositoryPolicy: "non-authoritative-until-plan-capability-qualifies",
      unknownRepositoryPolicy: "non-authoritative-until-explicit-admission",
      baseline: {
        observedOn: "2026-07-24",
        repositoryCount: 16,
        publicCount: 13,
        privateCount: 3,
        authoritativePublicTargetCount: Object.values(PUBLIC_REPOSITORY_TARGETS)
          .reduce((count, targets) => count + targets.length, 0),
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
      allowedBypassActors: "target-bound-official-integrations-only",
      conversationResolution: true,
      requiredChecks: "descriptor-bound-exact-context-and-app-identity",
      strictRequiredChecks: "descriptor-bound",
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

export function githubRepositoryIdentityRoot({
  provider = "github",
  providerRepositoryId,
} = {}) {
  return githubGovernanceDigest({
    provider: requiredString(provider, "repository identity provider"),
    providerRepositoryId: requiredString(
      providerRepositoryId,
      "provider repository id",
    ),
  });
}

function privateRepositoryPolicy(descriptor, identityRoot) {
  return descriptor.repositoryAdmission.privateRepositoryIdentities
    .find((entry) => entry.identityRoot === identityRoot);
}

function repositoryAdmission(descriptor, repository) {
  const [owner, name] = requiredString(repository.fullName, "repository full name").split("/");
  if (owner !== descriptor.organization) return "non-authoritative-foreign-owner";
  if (repository.visibility === "private") {
    return privateRepositoryPolicy(descriptor, repository.identityRoot)
      ? "admitted-private"
      : "non-authoritative-explicit-admission-required";
  }
  return descriptor.repositoryAdmission.publicRepositories.includes(name)
    ? "admitted-public"
    : "non-authoritative-explicit-admission-required";
}

function activeVersionLineTargets(defaultBranch) {
  const normalized = normalizedRef(defaultBranch);
  const match = normalized.match(/^dev\/(v\d+)\/(v\d+\.\d+)$/);
  if (!match) return [normalized];
  return [
    normalized,
    `alpha/${match[1]}/${match[2]}`,
    `release/${match[1]}/${match[2]}`,
  ];
}

function publicTargetPolicy(descriptor, repository, targetRef) {
  const name = requiredString(repository.fullName, "repository full name").split("/")[1];
  return (descriptor.repositoryAdmission.publicAuthoritativeTargets[name] || [])
    .find((entry) => entry.targetRef === normalizedRef(targetRef));
}

function privateTargetPolicy(descriptor, repository, targetRef) {
  const policy = privateRepositoryPolicy(descriptor, repository.identityRoot);
  if (!policy) return null;
  const normalized = normalizedRef(targetRef);
  if (!activeVersionLineTargets(repository.defaultBranch || normalized).includes(normalized)) {
    return null;
  }
  return {
    targetRef: normalized,
    ...(policy.requiredCheckPolicies?.[normalized] || {}),
  };
}

function targetPolicy(descriptor, repository, targetRef) {
  return repository.visibility === "private"
    ? privateTargetPolicy(descriptor, repository, targetRef)
    : publicTargetPolicy(descriptor, repository, targetRef);
}

export function resolveGithubGovernanceTargetPolicy({
  descriptor = BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY,
  repository,
  targetRef,
} = {}) {
  const fullName = requiredString(repository, "repository");
  const [owner] = fullName.split("/");
  if (owner !== descriptor.organization) {
    throw new Error("repository is outside the governance authority organization");
  }
  const policy = publicTargetPolicy(descriptor, {
    fullName,
    visibility: "public",
  }, targetRef);
  if (!policy) {
    throw new Error("target ref is not admitted by the governance authority");
  }
  return {
    ...structuredClone(policy),
    requiredApprovals: descriptor.authority.minimumIndependentApprovals,
  };
}

export function resolveGithubGovernanceTargetRefs({
  descriptor = BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY,
  repository,
  availableRefs = [],
  requestedTargetRef = "",
} = {}) {
  if (requestedTargetRef) return [normalizedRef(requestedTargetRef)];
  const defaultBranch = normalizedRef(repository.defaultBranch);
  if (repository.visibility === "private") {
    if (!privateRepositoryPolicy(descriptor, repository.identityRoot)) {
      return [defaultBranch];
    }
    const available = new Set(availableRefs.map(normalizedRef));
    return activeVersionLineTargets(defaultBranch)
      .filter((ref) => ref === defaultBranch || available.has(ref));
  }
  const name = requiredString(repository.fullName, "repository full name").split("/")[1];
  const admitted = descriptor.repositoryAdmission.publicAuthoritativeTargets[name] || [];
  return [...new Set([
    ...admitted.map((entry) => entry.targetRef),
    defaultBranch,
  ])].sort();
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
  const admittedTargetPolicy = targetPolicy(descriptor, repository || {}, targetRef);
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
  const observedCheckBindings = uniqueCheckBindings(policy.requiredCheckBindings || []);
  const observedCheckBindingRoot = githubGovernanceDigest(observedCheckBindings);
  const expectedCheckBindingRoot = admittedTargetPolicy?.requiredCheckBindingRoot ||
    (admittedTargetPolicy?.requiredCheckBindings
      ? githubGovernanceDigest(uniqueCheckBindings(
          admittedTargetPolicy.requiredCheckBindings.map((entry) => ({
            context: entry.context,
            appId: entry.appId,
          })),
        ))
      : "");
  const exactRequiredChecks = observedCheckBindings.length > 0 &&
    SHA256.test(expectedCheckBindingRoot) &&
    observedCheckBindingRoot === expectedCheckBindingRoot;
  const strictRequiredChecks = typeof admittedTargetPolicy?.strictRequiredChecks === "boolean" &&
    policy.strictRequiredChecks === admittedTargetPolicy.strictRequiredChecks;
  const observedBypassActors = uniqueBypassActors(policy.bypassActors);
  const allowedBypassActors = uniqueBypassActors(
    admittedTargetPolicy?.allowedBypassActors,
  );
  const unapprovedBypassActors = observedBypassActors.filter((actor) =>
    !allowedBypassActors.some((allowed) =>
      allowed.actorType === actor.actorType &&
      allowed.actorId === actor.actorId &&
      allowed.bypassMode === actor.bypassMode));
  const facts = [
    fact("api-evidence", apiPass, apiEvidence),
    fact("repository-admission", admitted, { admission, visibility: repository?.visibility }),
    fact("target-ref-admission", Boolean(admittedTargetPolicy), {
      targetAdmission: admittedTargetPolicy
        ? "admitted-authoritative-target"
        : "non-authoritative-target",
      targetRef: normalizedRef(targetRef),
    }),
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
    fact("bypass-policy", unapprovedBypassActors.length === 0, {
      bypassActors: observedBypassActors,
      allowedBypassActors,
      unapprovedBypassActors,
    }),
    fact("conversation-resolution", policy.conversationResolution === true, {
      conversationResolution: policy.conversationResolution,
    }),
    fact("required-checks", exactRequiredChecks, {
      requiredChecks: policy.requiredChecks || [],
      requiredCheckBindings: observedCheckBindings,
      observedCheckBindingRoot,
      expectedCheckBindingRoot,
    }),
    fact("strict-required-checks", strictRequiredChecks, {
      observed: policy.strictRequiredChecks === true,
      expected: admittedTargetPolicy?.strictRequiredChecks,
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
            nativePullRequestRequired: policy.nativePullRequestRequired,
            requiredApprovals: policy.requiredApprovals,
            codeOwnerReviewRequired: policy.codeOwnerReviewRequired,
            dismissStaleReviews: policy.dismissStaleReviews,
            requireLastPushApproval: policy.requireLastPushApproval,
            conversationResolution: policy.conversationResolution,
            requiredCheckBindings: observedCheckBindings,
            strictRequiredChecks: policy.strictRequiredChecks,
            enforceAdmins: policy.enforceAdmins,
            bypassActors: policy.bypassActors,
            allowForcePushes: policy.allowForcePushes,
            allowDeletions: policy.allowDeletions,
          })]
        : []),
    ].sort(),
    membershipAuthorityRoot: githubGovernanceDigest({
      development: { state: development.state || "", roleClass: development.role || "" },
      review: { state: review.state || "", roleClass: review.role || "" },
    }),
    requiredChecks: [...(policy.requiredChecks || [])].sort(),
    requiredCheckBindings: observedCheckBindings,
    requiredCheckBindingRoot: observedCheckBindingRoot,
    expectedRequiredCheckBindingRoot: expectedCheckBindingRoot,
    targetAdmission: admittedTargetPolicy
      ? "admitted-authoritative-target"
      : "non-authoritative-target",
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
      dismissal_restrictions: {
        users: [],
        teams: [],
        apps: [],
      },
      bypass_pull_request_allowances: {
        users: [],
        teams: [],
        apps: [],
      },
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
      bypassActors: [],
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

export function normalizeGithubRulesetSnapshot(ruleset = {}) {
  return {
    name: requiredString(ruleset.name, "ruleset name"),
    target: requiredString(ruleset.target, "ruleset target"),
    enforcement: requiredString(ruleset.enforcement, "ruleset enforcement"),
    bypass_actors: (ruleset.bypass_actors || []).map((actor) => ({
      actor_id: Number(actor?.actor_id || 0),
      actor_type: requiredString(actor?.actor_type, "ruleset bypass actor type"),
      bypass_mode: requiredString(actor?.bypass_mode, "ruleset bypass mode"),
    })),
    conditions: structuredClone(ruleset.conditions || {}),
    rules: structuredClone(ruleset.rules || []),
  };
}

export function createGithubRulesetBypassRolloutPlan({
  repository,
  rulesetId,
  inventory,
  rollbackSnapshot,
} = {}) {
  const fullName = requiredString(repository, "repository");
  const id = Number(rulesetId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("ruleset id must be a positive integer");
  }
  if (!inventory || !rollbackSnapshot) {
    throw new Error("read-only inventory and frozen rollback snapshot are required");
  }
  const before = normalizeGithubRulesetSnapshot(rollbackSnapshot);
  const desired = { ...before, bypass_actors: [] };
  const endpoint = `repos/${fullName}/rulesets/${id}`;
  const core = {
    schemaVersion: 1,
    contract: GITHUB_GOVERNANCE_RULESET_ROLLOUT_CONTRACT,
    repository: fullName,
    rulesetId: id,
    inventoryRoot: githubGovernanceDigest(inventory),
    rollbackSnapshotRoot: githubGovernanceDigest(before),
    operations: [{ method: "PUT", endpoint, body: desired }],
    impact: [
      "remove every user, team, and App bypass actor from one exact repository ruleset",
      "preserve the ruleset name, target, enforcement, conditions, and rules",
    ],
    expectedObservation: {
      rulesetRoot: githubGovernanceDigest(desired),
      bypassActors: [],
    },
    rollback: [{
      method: "PUT",
      endpoint,
      body: before,
      preconditionRoot: githubGovernanceDigest(before),
    }],
  };
  return { ...core, planRoot: githubGovernanceDigest(core) };
}

function providerRulesetCheckBindings(bindings) {
  return (bindings || []).map((entry) => {
    const context = requiredString(entry?.context, "required check context");
    const appId = entry?.app_id ?? entry?.appId ?? null;
    if (appId !== null && (!Number.isInteger(appId) || appId <= 0)) {
      throw new Error(`required check app id must be a positive integer or null: ${context}`);
    }
    return {
      context,
      ...(appId === null ? {} : { integration_id: appId }),
    };
  });
}

function providerRulesetBypassActors(actors) {
  return (actors || []).map((actor) => {
    const actorId = Number(actor?.actor_id ?? actor?.actorId ?? 0);
    const actorType = requiredString(
      actor?.actor_type ?? actor?.actorType,
      "ruleset bypass actor type",
    );
    const bypassMode = requiredString(
      actor?.bypass_mode ?? actor?.bypassMode,
      "ruleset bypass mode",
    );
    if (!Number.isInteger(actorId) || actorId <= 0) {
      throw new Error("ruleset bypass actor id must be a positive integer");
    }
    return {
      actor_id: actorId,
      actor_type: actorType,
      bypass_mode: bypassMode,
    };
  });
}

export function createGithubRulesetGovernanceRolloutPlan({
  repository,
  targetRef,
  rulesetId,
  rulesetName,
  inventory,
  rollbackSnapshot,
  desiredProtection,
} = {}) {
  const fullName = requiredString(repository, "repository");
  const branch = normalizedRef(targetRef);
  const creating = rulesetId === null || rulesetId === undefined || rulesetId === "";
  const id = creating ? null : Number(rulesetId);
  if (!creating && (!Number.isInteger(id) || id <= 0)) {
    throw new Error("ruleset id must be a positive integer when supplied");
  }
  if (!inventory || (!creating && !rollbackSnapshot)) {
    throw new Error(
      "read-only inventory and any existing frozen rollback snapshot are required",
    );
  }
  const before = creating
    ? {
        name: requiredString(rulesetName, "ruleset name"),
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: {
          ref_name: {
            include: [`refs/heads/${branch}`],
            exclude: [],
          },
        },
        rules: [],
      }
    : normalizeGithubRulesetSnapshot(rollbackSnapshot);
  const exactInclude = before.conditions?.ref_name?.include || [];
  const exactExclude = before.conditions?.ref_name?.exclude || [];
  if (
    exactInclude.length !== 1 ||
    exactInclude[0] !== `refs/heads/${branch}` ||
    exactExclude.length !== 0
  ) {
    throw new Error("ruleset policy rollout requires one exact target branch condition");
  }
  const requiredStatusChecks = providerRulesetCheckBindings(
    desiredProtection?.requiredCheckBindings,
  );
  if (requiredStatusChecks.length === 0) {
    throw new Error("ruleset policy rollout requires descriptor-bound status checks");
  }
  const requiredApprovals = Number(desiredProtection?.requiredApprovals);
  if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1) {
    throw new Error("ruleset policy rollout requires a positive approval count");
  }
  const pullRequestRules = before.rules.filter((rule) => rule.type === "pull_request");
  const statusCheckRules = before.rules.filter(
    (rule) => rule.type === "required_status_checks",
  );
  if (pullRequestRules.length > 1 || statusCheckRules.length > 1) {
    throw new Error("ruleset policy rollout rejects duplicate managed rule types");
  }
  const desiredPullRequestRule = {
    type: "pull_request",
    parameters: {
      allowed_merge_methods: ["merge", "squash", "rebase"],
      dismissal_restriction: {
        allowed_actors: [],
        enabled: false,
      },
      required_reviewers: [],
      ...(pullRequestRules[0]?.parameters || {}),
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: true,
      require_last_push_approval: true,
      required_approving_review_count: requiredApprovals,
      required_review_thread_resolution: true,
    },
  };
  const desiredStatusCheckRule = {
    type: "required_status_checks",
    parameters: {
      do_not_enforce_on_create: false,
      ...(statusCheckRules[0]?.parameters || {}),
      required_status_checks: requiredStatusChecks,
      strict_required_status_checks_policy:
        desiredProtection?.strictRequiredChecks === true,
    },
  };
  const desiredRules = before.rules.map((rule) => {
    if (rule.type === "pull_request") return desiredPullRequestRule;
    if (rule.type === "required_status_checks") return desiredStatusCheckRule;
    return structuredClone(rule);
  });
  if (pullRequestRules.length === 0) desiredRules.push(desiredPullRequestRule);
  if (statusCheckRules.length === 0) desiredRules.push(desiredStatusCheckRule);
  if (
    desiredProtection?.blockDeletions === true &&
    !desiredRules.some((rule) => rule.type === "deletion")
  ) {
    desiredRules.push({ type: "deletion" });
  }
  if (
    desiredProtection?.blockNonFastForward === true &&
    !desiredRules.some((rule) => rule.type === "non_fast_forward")
  ) {
    desiredRules.push({ type: "non_fast_forward" });
  }
  const desired = {
    ...before,
    name: rulesetName
      ? requiredString(rulesetName, "ruleset name")
      : before.name,
    bypass_actors: providerRulesetBypassActors(
      desiredProtection?.rulesetBypassActors,
    ),
    rules: desiredRules,
  };
  const endpoint = creating
    ? `repos/${fullName}/rulesets`
    : `repos/${fullName}/rulesets/${id}`;
  const core = {
    schemaVersion: 1,
    contract: GITHUB_GOVERNANCE_RULESET_ROLLOUT_CONTRACT,
    repository: fullName,
    targetRef: branch,
    rulesetId: id,
    rulesetName: desired.name,
    action: creating ? "create" : "update",
    inventoryRoot: githubGovernanceDigest(inventory),
    rollbackSnapshotRoot: creating
      ? githubGovernanceDigest({ rulesetExists: false, targetRef: branch })
      : githubGovernanceDigest(before),
    operations: [
      { method: creating ? "POST" : "PUT", endpoint, body: desired },
    ],
    impact: [
      "replace ruleset bypass actors with the exact provider-admitted desired set",
      "require fresh Code Owner review and resolved review threads",
      "bind required status checks and strictness to the authoritative target descriptor",
      creating
        ? "create one exact-branch active ruleset because no matching ruleset exists"
        : "preserve unrelated ruleset rules and exact target conditions",
    ],
    expectedObservation: {
      rulesetRoot: githubGovernanceDigest(desired),
      bypassActors: desired.bypass_actors,
      requiredCheckBindings: requiredStatusChecks,
      strictRequiredChecks:
        desiredProtection?.strictRequiredChecks === true,
      requiredApprovals,
    },
    rollback: creating
      ? [
          {
            method: "DELETE",
            endpoint: `repos/${fullName}/rulesets/{ruleset_id}`,
            body: null,
            preconditionRoot: githubGovernanceDigest(desired),
            requiresApplyReceipt: true,
          },
        ]
      : [
          {
            method: "PUT",
            endpoint,
            body: before,
            preconditionRoot: githubGovernanceDigest(before),
          },
        ],
  };
  return { ...core, planRoot: githubGovernanceDigest(core) };
}

export const BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY =
  Object.freeze(createBuildchainGithubGovernanceAuthority());
export const BUILDCHAIN_GITHUB_GOVERNANCE_PROTECTED_PATHS =
  PROTECTED_AUTHORITY_PATHS;
