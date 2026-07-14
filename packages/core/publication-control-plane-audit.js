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
  environment,
  branch,
  packageName,
  publisherMode = "npm-trusted-publisher",
  snapshot,
  observedAt,
  expiresAt,
} = {}) {
  const workflowFilename = String(workflowPath || "").split("/").pop();
  const actions = snapshot?.actions || {};
  const branchPolicy = snapshot?.branch || {};
  const environmentPolicy = snapshot?.environment || {};
  const oidc = snapshot?.oidc || {};
  const publisher = snapshot?.publisher || {};
  const runner = snapshot?.runner || {};
  const publisherPass = publisherMode === "npm-trusted-publisher"
    ? publisher.packageName === packageName &&
      publisher.provider === "github" &&
      publisher.repository === repository &&
      publisher.workflowFilename === workflowFilename &&
      publisher.environment === environment &&
      publisher.allowPublish === true &&
      publisher.longLivedWorkflowCredentialPresent === false
    : publisherMode === "github-token"
      ? publisher.provider === "github-token" &&
        publisher.repository === repository &&
        publisher.workflowPath === workflowPath &&
        publisher.permissionScoped === true &&
        publisher.longLivedWorkflowCredentialPresent === false
      : publisherMode === "oidc-role"
        ? publisher.provider !== "" &&
          publisher.repository === repository &&
          publisher.workflowPath === workflowPath &&
          publisher.environment === environment &&
          publisher.trustQualifying === true &&
          /^[0-9a-f]{64}$/i.test(String(publisher.roleDigest || "").replace(/^sha256:/, "")) &&
          publisher.longLivedWorkflowCredentialPresent === false
        : false;
  const credentialIsolationPass = publisherMode === "github-token"
    ? oidc.githubTokenJobScoped === true && oidc.longLivedCredentialPresent === false
    : oidc.workflowPath === workflowPath &&
      oidc.environment === environment &&
      oidc.idTokenJobScoped === true &&
      oidc.longLivedCredentialPresent === false;
  const facts = [
    fact(
      "actions-policy",
      actions.defaultWorkflowPermissions === "read" && actions.canApprovePullRequestReviews === false,
      actions,
    ),
    fact(
      "branch-policy",
      branchPolicy.ref === branch &&
        branchPolicy.strict === true &&
        Number(branchPolicy.requiredApprovals || 0) >= 1 &&
        branchPolicy.requireConversationResolution === true &&
        branchPolicy.enforceAdmins === true,
      branchPolicy,
    ),
    fact(
      "environment-policy",
        environmentPolicy.name === environment &&
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
    environment,
    facts,
    observedAt,
    expiresAt,
  });
}
