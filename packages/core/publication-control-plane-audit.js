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
        environmentPolicy.preventSelfReview === true,
      environmentPolicy,
    ),
    fact(
      "oidc-policy",
      oidc.workflowPath === workflowPath &&
        oidc.environment === environment &&
        oidc.idTokenJobScoped === true &&
        oidc.longLivedCredentialPresent === false,
      oidc,
    ),
    fact(
      "publisher-policy",
      publisher.packageName === packageName &&
        publisher.provider === "github" &&
        publisher.repository === repository &&
        publisher.workflowFilename === workflowFilename &&
        publisher.environment === environment &&
        publisher.allowPublish === true &&
        publisher.tokensDisallowed === true,
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
