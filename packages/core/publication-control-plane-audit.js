import { createPublicationControlPlaneAudit, publicationAuthorityDigest } from "./publication-authority.js";

export const BUILDCHAIN_RELEASE_RECONCILIATION_PATHS = Object.freeze([
  ".buildchain/release-impact.json",
  "dist/site/buildchain-contract.json",
  "dist/site/buildchain-site.json",
  "dist/site/kfd-upstream-aggregate.json",
  "dist/site/publication-registry.json",
  "dist/site/site-manifest.json",
  "package.json",
]);

function deploymentPatternExpression(pattern) {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`);
}

export function matchesGithubDeploymentPolicy(policy, { ref, refType = "branch" } = {}) {
  const normalizedRef = String(ref || "");
  const normalizedType = String(refType || "");
  const policyName = String(policy?.name || "");
  const policyType = String(policy?.type || "");
  if (!normalizedRef || !["branch", "tag"].includes(normalizedType)) return false;
  if (policyType !== normalizedType || !policyName) return false;
  return deploymentPatternExpression(policyName).test(normalizedRef);
}

export function evaluateBuildchainReleaseReconciliation({
  repository,
  publicationVersion,
  packageVersion,
  message,
  parentSha,
  changedPaths,
} = {}) {
  const normalizedPaths = Array.isArray(changedPaths) ? changedPaths.map(String) : [];
  const allowedPaths = new Set(BUILDCHAIN_RELEASE_RECONCILIATION_PATHS);
  return {
    qualifying: repository === "kungfu-systems/buildchain" &&
      /^\d+\.\d+\.\d+$/.test(String(publicationVersion || "")) &&
      message === `chore(release): release v${publicationVersion}` &&
      packageVersion === publicationVersion &&
      normalizedPaths.length > 0 &&
      normalizedPaths.every((entry) => allowedPaths.has(entry)) &&
      /^[0-9a-f]{40}$/.test(String(parentSha || "")),
    parentSha: String(parentSha || ""),
    version: String(publicationVersion || ""),
    packageVersion: String(packageVersion || ""),
    message: String(message || ""),
    changedPaths: normalizedPaths,
  };
}

function fact(id, pass, observed) {
  return {
    id,
    status: pass ? "pass" : "fail",
    digest: publicationAuthorityDigest({ id, observed }),
  };
}

function evaluatePublisherPolicy({
  publisher,
  publisherMode,
  packageName,
  repository,
  workflowPath,
  publisherWorkflowPath,
  workflowFilename,
  environment,
  providerEnvironment,
}) {
  if (publisherMode === "npm-trusted-publisher") {
    const identityPass = publisher.packageName === packageName &&
      publisher.provider === "github" &&
      publisher.repository === repository &&
      publisher.workflowFilename === workflowFilename &&
      publisher.environment === providerEnvironment &&
      publisher.longLivedWorkflowCredentialPresent === false;
    return identityPass && (
      (publisher.enforcement === "audited-control-plane" && publisher.allowPublish === true) ||
      (publisher.enforcement === "provider-at-transaction" &&
        publisher.authorizationDeferred === true &&
        publisher.configurationRead === false)
    );
  }
  if (publisherMode === "github-token") {
    return publisher.provider === "github-token" &&
      publisher.repository === repository &&
      publisher.workflowPath === workflowPath &&
      publisher.permissionScoped === true &&
      publisher.longLivedWorkflowCredentialPresent === false;
  }
  if (publisherMode !== "oidc-role") return false;
  return publisher.provider !== "" &&
    publisher.repository === repository &&
    publisher.workflowPath === publisherWorkflowPath &&
    publisher.environment === environment &&
    publisher.trustQualifying === true &&
    /^[0-9a-f]{64}$/i.test(String(publisher.roleDigest || "").replace(/^sha256:/, "")) &&
    publisher.longLivedWorkflowCredentialPresent === false;
}

function evaluateCredentialIsolation({ oidc, publisherMode, publisherWorkflowPath, providerEnvironment }) {
  return publisherMode === "github-token"
    ? oidc.githubTokenJobScoped === true && oidc.longLivedCredentialPresent === false
    : oidc.workflowPath === publisherWorkflowPath &&
      oidc.environment === providerEnvironment &&
      oidc.idTokenJobScoped === true &&
      oidc.longLivedCredentialPresent === false;
}

function requiredStatusCheckBinding(branchPolicy, requiredStatusCheck) {
  const declared = branchPolicy.declaredRequiredStatusCheck || branchPolicy.requiredStatusCheck;
  const resolved = branchPolicy.requiredStatusCheck;
  return {
    resolved,
    pass: declared === requiredStatusCheck && (
      resolved === declared ||
      (resolved.startsWith(`${declared} / `) && branchPolicy.requiredStatusCheckMatchCount === 1)
    ),
  };
}

function sourceAuthorizationPass(branchPolicy) {
  const authorizationSha = branchPolicy.authorizationSha || branchPolicy.sourceSha;
  return branchPolicy.sourceSha === authorizationSha || (
    branchPolicy.releaseReconciliation?.qualifying === true &&
    branchPolicy.releaseReconciliation.parentSha === authorizationSha &&
    /^\d+\.\d+\.\d+$/.test(String(branchPolicy.releaseReconciliation.version || "")) &&
    branchPolicy.releaseReconciliation.packageVersion === branchPolicy.releaseReconciliation.version &&
    Array.isArray(branchPolicy.releaseReconciliation.changedPaths) &&
    branchPolicy.releaseReconciliation.changedPaths.length > 0
  );
}

function evaluateConfiguredBranchPolicy(branchPolicy, branch) {
  return branchPolicy.ref === branch &&
    branchPolicy.strict === true &&
    Number(branchPolicy.requiredApprovals || 0) >= 1 &&
    branchPolicy.requireConversationResolution === true &&
    branchPolicy.enforceAdmins === true;
}

function evaluateProviderBranchPolicy(branchPolicy, branch, requiredCheck) {
  return branchPolicy.ref === branch &&
    branchPolicy.policyMode === "provider-enforced-transaction" &&
    branchPolicy.protected === true &&
    branchPolicy.enforcementLevel === "everyone" &&
    Array.isArray(branchPolicy.requiredStatusChecks) &&
    requiredCheck.pass &&
    branchPolicy.requiredStatusChecks.includes(requiredCheck.resolved) &&
    branchPolicy.requiredCheckPassed === true &&
    /^[0-9a-f]{40}$/i.test(String(branchPolicy.requiredCheckSha || "")) &&
    branchPolicy.requiredCheckSha === branchPolicy.pullRequestHeadSha;
}

function evaluateProviderPullRequest(branchPolicy, branch, repository) {
  return (branchPolicy.sourceSha === branchPolicy.headSha || branchPolicy.sourceContainedInBranch === true) &&
    sourceAuthorizationPass(branchPolicy) &&
    branchPolicy.mergedPullRequest === true &&
    branchPolicy.baseRef === branch &&
    branchPolicy.headRepository === repository &&
    Number(branchPolicy.approvalCount || 0) >= 1 &&
    branchPolicy.independentApproval === true;
}

function evaluateBranchPolicy({ branchPolicy, branch, repository, requiredStatusCheck }) {
  const requiredCheck = requiredStatusCheckBinding(branchPolicy, requiredStatusCheck);
  return evaluateConfiguredBranchPolicy(branchPolicy, branch) || (
    evaluateProviderBranchPolicy(branchPolicy, branch, requiredCheck) &&
    evaluateProviderPullRequest(branchPolicy, branch, repository)
  );
}

function evaluateEnvironmentPolicy(environmentPolicy, environment) {
  return environment === "none"
    ? environmentPolicy.declared === false && environmentPolicy.exists === false
    : environmentPolicy.name === environment &&
      environmentPolicy.declared === true &&
      environmentPolicy.exists === true &&
      environmentPolicy.protected === true &&
      environmentPolicy.branchAuthorized === true &&
      (environmentPolicy.reviewRequired !== true || environmentPolicy.preventSelfReview === true);
}

function evaluateRunnerPolicy(runner) {
  return runner.class === "ephemeral" &&
    runner.label === "ubuntu-24.04" &&
    runner.githubHosted === true &&
    runner.selfHostedAuthorized === false;
}

export function evaluatePublicationControlPlaneSnapshot(options = {}) {
  const {
    repository,
    workflowPath,
    publisherWorkflowPath = workflowPath,
    environment,
    branch,
    packageName,
    publisherMode = "npm-trusted-publisher",
    requiredStatusCheck = "check",
    snapshot,
    observedAt,
    expiresAt,
  } = options;
  const workflowFilename = String(publisherWorkflowPath || "").split("/").pop();
  const providerEnvironment = environment === "none" ? "" : environment;
  const actions = snapshot?.actions || {};
  const branchPolicy = snapshot?.branch || {};
  const environmentPolicy = snapshot?.environment || {};
  const oidc = snapshot?.oidc || {};
  const publisher = snapshot?.publisher || {};
  const runner = snapshot?.runner || {};
  const facts = [
    fact("actions-policy", actions.defaultWorkflowPermissions === "read" && actions.canApprovePullRequestReviews === false, actions),
    fact("branch-policy", evaluateBranchPolicy({ branchPolicy, branch, repository, requiredStatusCheck }), branchPolicy),
    fact("environment-policy", evaluateEnvironmentPolicy(environmentPolicy, environment), environmentPolicy),
    fact("oidc-policy", evaluateCredentialIsolation({ oidc, publisherMode, publisherWorkflowPath, providerEnvironment }), oidc),
    fact("publisher-policy", evaluatePublisherPolicy({
      publisher, publisherMode, packageName, repository, workflowPath,
      publisherWorkflowPath, workflowFilename, environment, providerEnvironment,
    }), publisher),
    fact("runner-policy", evaluateRunnerPolicy(runner), runner),
  ];
  return createPublicationControlPlaneAudit({
    repository, workflowPath, publisherWorkflowPath, environment, facts, observedAt, expiresAt,
  });
}
