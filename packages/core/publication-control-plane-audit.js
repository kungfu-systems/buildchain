import { createPublicationControlPlaneAudit, publicationAuthorityDigest } from "./publication-authority.js";

function fact(id, pass, observed) {
  return {
    id,
    status: pass ? "pass" : "fail",
    digest: publicationAuthorityDigest({ id, observed }),
  };
}

export function evaluatePublicationControlPlaneSnapshot({
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
} = {}) {
  const workflowFilename = String(publisherWorkflowPath || "").split("/").pop();
  const providerEnvironment = environment === "none" ? "" : environment;
  const actions = snapshot?.actions || {};
  const branchPolicy = snapshot?.branch || {};
  const environmentPolicy = snapshot?.environment || {};
  const oidc = snapshot?.oidc || {};
  const publisher = snapshot?.publisher || {};
  const runner = snapshot?.runner || {};
  const npmIdentityPass = publisher.packageName === packageName &&
    publisher.provider === "github" &&
    publisher.repository === repository &&
    publisher.workflowFilename === workflowFilename &&
    publisher.environment === providerEnvironment &&
    publisher.longLivedWorkflowCredentialPresent === false;
  const publisherPass = publisherMode === "npm-trusted-publisher"
    ? npmIdentityPass && (
      (publisher.enforcement === "audited-control-plane" && publisher.allowPublish === true) ||
      (publisher.enforcement === "provider-at-transaction" &&
        publisher.authorizationDeferred === true &&
        publisher.configurationRead === false)
    )
    : publisherMode === "github-token"
      ? publisher.provider === "github-token" &&
        publisher.repository === repository &&
        publisher.workflowPath === publisherWorkflowPath &&
        publisher.permissionScoped === true &&
        publisher.longLivedWorkflowCredentialPresent === false
      : publisherMode === "oidc-role"
        ? publisher.provider !== "" &&
          publisher.repository === repository &&
          publisher.workflowPath === publisherWorkflowPath &&
          publisher.environment === environment &&
          publisher.trustQualifying === true &&
          /^[0-9a-f]{64}$/i.test(String(publisher.roleDigest || "").replace(/^sha256:/, "")) &&
          publisher.longLivedWorkflowCredentialPresent === false
        : false;
  const credentialIsolationPass = publisherMode === "github-token"
    ? oidc.githubTokenJobScoped === true && oidc.longLivedCredentialPresent === false
    : oidc.workflowPath === publisherWorkflowPath &&
      oidc.environment === providerEnvironment &&
      oidc.idTokenJobScoped === true &&
      oidc.longLivedCredentialPresent === false;
  const configuredBranchPolicyPass = branchPolicy.ref === branch &&
    branchPolicy.strict === true &&
    Number(branchPolicy.requiredApprovals || 0) >= 1 &&
    branchPolicy.requireConversationResolution === true &&
    branchPolicy.enforceAdmins === true;
  const providerTransactionBranchPass = branchPolicy.ref === branch &&
    branchPolicy.policyMode === "provider-enforced-transaction" &&
    branchPolicy.protected === true &&
    branchPolicy.enforcementLevel === "everyone" &&
    Array.isArray(branchPolicy.requiredStatusChecks) &&
    branchPolicy.requiredStatusCheck === requiredStatusCheck &&
    branchPolicy.requiredStatusChecks.includes(requiredStatusCheck) &&
    branchPolicy.requiredCheckPassed === true &&
    /^[0-9a-f]{40}$/i.test(String(branchPolicy.requiredCheckSha || "")) &&
    branchPolicy.requiredCheckSha === branchPolicy.pullRequestHeadSha &&
    branchPolicy.sourceSha === branchPolicy.headSha &&
    branchPolicy.mergedPullRequest === true &&
    branchPolicy.baseRef === branch &&
    branchPolicy.headRepository === repository &&
    Number(branchPolicy.approvalCount || 0) >= 1 &&
    branchPolicy.independentApproval === true;
  const facts = [
    fact(
      "actions-policy",
      actions.defaultWorkflowPermissions === "read" && actions.canApprovePullRequestReviews === false,
      actions,
    ),
    fact(
      "branch-policy",
      configuredBranchPolicyPass || providerTransactionBranchPass,
      branchPolicy,
    ),
    fact(
      "environment-policy",
      environment === "none"
        ? environmentPolicy.declared === false && environmentPolicy.exists === false
        : environmentPolicy.name === environment &&
          environmentPolicy.declared === true &&
          environmentPolicy.exists === true &&
          environmentPolicy.protected === true &&
          (environmentPolicy.reviewRequired !== true || environmentPolicy.preventSelfReview === true),
      environmentPolicy,
    ),
    fact(
      "oidc-policy",
      credentialIsolationPass,
      oidc,
    ),
    fact(
      "publisher-policy",
      publisherPass,
      publisher,
    ),
    fact(
      "runner-policy",
      runner.class === "ephemeral" &&
        runner.label === "ubuntu-24.04" &&
        runner.githubHosted === true &&
        runner.selfHostedAuthorized === false,
      runner,
    ),
  ];
  return createPublicationControlPlaneAudit({
    repository,
    workflowPath,
    publisherWorkflowPath,
    environment,
    facts,
    observedAt,
    expiresAt,
  });
}
