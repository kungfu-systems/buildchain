import path from "node:path";
import {
  evaluatePublicationControlPlaneSnapshot,
  matchesGithubDeploymentPolicy,
} from "../../publication/publication-control-plane-audit.js";
import {
  normalizeRulesetBranchPolicy,
  jobBlock,
  normalizeNpmPublisher,
} from "./policy-values.js";
import { observePublicationSourceAuthorization } from "./source-authorization.js";
function observePublicationEnvironment({
  repository,
  environment,
  environmentRef,
  environmentRefType,
  branchState,
  githubJson,
}) {
  const environmentState =
    environment === "none"
      ? {}
      : githubJson(
          `repos/${repository}/environments/${encodeURIComponent(environment)}`,
          "publication Environment",
        );
  const deploymentBranches =
    environment !== "none" &&
    environmentState.deployment_branch_policy?.custom_branch_policies === true
      ? githubJson(
          `repos/${repository}/environments/${encodeURIComponent(environment)}/deployment-branch-policies?per_page=100`,
          "Environment deployment branch policy",
        )
      : { branch_policies: [] };
  if (!["branch", "tag"].includes(environmentRefType)) {
    throw new Error(
      `unsupported --environment-ref-type: ${environmentRefType}`,
    );
  }
  const matchingEnvironmentPolicy = (
    deploymentBranches.branch_policies || []
  ).find((entry) =>
    matchesGithubDeploymentPolicy(entry, {
      ref: environmentRef,
      refType: environmentRefType,
    }),
  );
  const environmentBranchAuthorized =
    environment !== "none" &&
    ((environmentRefType === "branch" &&
      environmentState.deployment_branch_policy?.protected_branches === true &&
      branchState.protected === true) ||
      Boolean(matchingEnvironmentPolicy));

  return {
    environmentState,
    deploymentBranches,
    matchingEnvironmentPolicy,
    environmentBranchAuthorized,
  };
}

function observePublisherAuthority({
  publisherMode,
  npmTrust,
  packageName,
  repository,
  publisherWorkflowPath,
  providerEnvironment,
  workflowPath,
  block,
  workflowText,
  providerAudit,
  longLivedWorkflowCredentialPresent,
}) {
  let publisher;
  if (publisherMode === "npm-trusted-publisher") {
    const trust = npmTrust;
    publisher = trust
      ? normalizeNpmPublisher(trust, {
          packageName,
          repository,
          workflowFilename: path.basename(publisherWorkflowPath),
          environment: providerEnvironment,
        })
      : {
          packageName,
          provider: "github",
          repository,
          workflowFilename: path.basename(publisherWorkflowPath),
          environment: providerEnvironment,
          allowPublish: false,
          enforcement: "provider-at-transaction",
          authorizationDeferred: true,
          configurationRead: false,
        };
  } else if (publisherMode === "github-token") {
    publisher = {
      provider: "github-token",
      repository,
      workflowPath,
      permissionScoped:
        /^\s{6}contents:\s*write\s*$/m.test(block) &&
        !/^\s{2}contents:\s*write\s*$/m.test(workflowText),
    };
  } else {
    publisher = providerAudit;
  }
  publisher.longLivedWorkflowCredentialPresent =
    longLivedWorkflowCredentialPresent;

  return publisher;
}

function sealPublicationControlPlane({
  environmentState,
  block,
  repository,
  workflowPath,
  publisherWorkflowPath,
  environment,
  branch,
  packageName,
  publisherMode,
  requiredStatusCheck,
  explicitReadOnlyWorkflowPermissions,
  branchPolicy,
  environmentDeclared,
  deploymentBranches,
  environmentBranchAuthorized,
  environmentRefType,
  matchingEnvironmentPolicy,
  environmentRef,
  providerEnvironment,
  workflowText,
  publisher,
  oidc,
}) {
  const reviewRules = (environmentState.protection_rules || []).filter(
    (rule) => rule.type === "required_reviewers",
  );
  const runsOn = (block.match(/^\s{4}runs-on:\s*([^\n#]+)/m)?.[1] || "")
    .trim()
    .replace(/["']/g, "");
  const observedAt = new Date();
  const expiresAt = new Date(observedAt.getTime() + 10 * 60 * 1000);
  const receipt = evaluatePublicationControlPlaneSnapshot({
    repository,
    workflowPath,
    publisherWorkflowPath,
    environment,
    branch,
    packageName,
    publisherMode,
    requiredStatusCheck,
    observedAt: observedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    snapshot: {
      actions: {
        defaultWorkflowPermissions: explicitReadOnlyWorkflowPermissions
          ? "read"
          : "unqualified",
        canApprovePullRequestReviews: false,
        evidenceSource: "exact-workflow-source",
      },
      branch: branchPolicy,
      environment: {
        name:
          environment === "none"
            ? "none"
            : environmentState.name || environment,
        declared: environmentDeclared,
        exists: Boolean(environmentState.id || environmentState.node_id),
        protected:
          (environmentState.protection_rules || []).length > 0 ||
          environmentState.deployment_branch_policy?.protected_branches ===
            true ||
          (deploymentBranches.branch_policies || []).length > 0,
        branchAuthorized: environmentBranchAuthorized,
        branchPolicyMode:
          environmentRefType === "branch" &&
          environmentState.deployment_branch_policy?.protected_branches === true
            ? "protected-branches"
            : matchingEnvironmentPolicy
              ? `custom-${environmentRefType}-policy`
              : "unqualified",
        authorizedBranch: matchingEnvironmentPolicy?.name || "",
        authorizedRef: environmentRef,
        authorizedRefType: environmentRefType,
        reviewRequired: reviewRules.length > 0,
        preventSelfReview: reviewRules.some(
          (rule) => rule.prevent_self_review === true,
        ),
      },
      oidc: {
        workflowPath: publisherWorkflowPath,
        environment: providerEnvironment,
        idTokenJobScoped:
          /^\s{6}id-token:\s*write\s*$/m.test(block) &&
          !/^\s{2}id-token:\s*write\s*$/m.test(workflowText),
        githubTokenJobScoped:
          /^\s{6}contents:\s*write\s*$/m.test(block) &&
          !/^\s{2}contents:\s*write\s*$/m.test(workflowText),
        longLivedCredentialPresent:
          publisher.longLivedWorkflowCredentialPresent,
        useDefaultSubject: oidc.use_default === true,
        includedClaims: oidc.include_claim_keys || [],
      },
      publisher,
      runner: {
        class: runsOn === "ubuntu-24.04" ? "ephemeral" : "unqualified",
        label: runsOn,
        githubHosted: runsOn === "ubuntu-24.04",
        selfHostedAuthorized: /self-hosted/i.test(runsOn),
        evidenceSource: "exact-workflow-job",
      },
    },
  });
  return receipt;
}

export function collectPublicationControlPlane(
  {
    repository,
    workflowRepository = repository,
    workflowPath = ".github/workflows/public-release-promote.yml",
    workflowRef = "",
    publisherWorkflowPath = workflowPath,
    requiredStatusCheck = "check",
    jobId = "promote",
    environment = "none",
    branch,
    environmentRef = branch,
    environmentRefType = "branch",
    sourceSha = "",
    packageName = "@kungfu-tech/buildchain",
    publisherMode = "npm-trusted-publisher",
    publicationVersion = "",
    allowReleaseReconciliation = false,
    npmTrust = null,
    providerAudit = null,
  },
  { githubJson, githubPublicJson, githubJsonOptional, githubJsonReadLimited },
) {
  const providerEnvironment = environment === "none" ? "" : environment;
  if (!repository || !branch)
    throw new Error("repository and branch are required");
  const encodedWorkflow = workflowPath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const workflowFile = githubPublicJson(
    `repos/${workflowRepository}/contents/${encodedWorkflow}${workflowRef ? `?ref=${encodeURIComponent(workflowRef)}` : ""}`,
    "publication workflow source",
  );
  const workflowText = Buffer.from(
    String(workflowFile.content || ""),
    "base64",
  ).toString("utf8");
  const block = jobBlock(workflowText, jobId);
  if (!block)
    throw new Error(
      `publication workflow job is missing: ${workflowPath}#${jobId}`,
    );
  const jobsOffset = workflowText.search(/^jobs:\s*$/m);
  const workflowHeader =
    jobsOffset === -1 ? workflowText : workflowText.slice(0, jobsOffset);
  const explicitReadOnlyWorkflowPermissions =
    /^permissions:\s*\n(?:^[ \t]+[a-z-]+:\s*read\s*$\n?)+/m.test(
      workflowHeader,
    ) &&
    !/^\s*[a-z-]+:\s*write\s*$/m.test(workflowHeader) &&
    !/permissions\s*:\s*write-all/i.test(workflowHeader);

  const repositoryState = githubPublicJson(
    `repos/${repository}`,
    "repository metadata",
  );
  const branchState = githubPublicJson(
    `repos/${repository}/branches/${encodeURIComponent(branch)}`,
    "branch summary",
  );
  const exactTransactionSource = /^[0-9a-f]{40}$/.test(sourceSha);
  const protection = exactTransactionSource
    ? null
    : githubJsonReadLimited(
        `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`,
        "branch protection",
        null,
      );
  const rulesetList = githubJsonOptional(
    `repos/${repository}/rulesets?includes_parents=true&per_page=100`,
    "repository rulesets",
    [],
  );
  const rulesets = [];
  for (const entry of Array.isArray(rulesetList) ? rulesetList : []) {
    if (!entry?.id) continue;
    rulesets.push(
      githubJson(
        `repos/${repository}/rulesets/${entry.id}`,
        `repository ruleset ${entry.id}`,
      ),
    );
  }
  const environmentDeclared = /^ {4}environment\s*:/m.test(block);
  const {
    environmentState,
    deploymentBranches,
    matchingEnvironmentPolicy,
    environmentBranchAuthorized,
  } = observePublicationEnvironment({
    repository,
    environment,
    environmentRef,
    environmentRefType,
    branchState,
    githubJson,
  });
  const oidc = githubJson(
    `repos/${repository}/actions/oidc/customization/sub`,
    "OIDC subject policy",
  );
  if (
    !["npm-trusted-publisher", "github-token", "oidc-role"].includes(
      publisherMode,
    )
  ) {
    throw new Error(`unsupported --publisher-mode: ${publisherMode}`);
  }
  const longLivedWorkflowCredentialPresent =
    /^\s*(?:NODE_AUTH_TOKEN|NPM_TOKEN|npm-token|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\s*:/im.test(
      block,
    ) ||
    /\$\{\{\s*secrets\.(?:NODE_AUTH_TOKEN|NPM_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\b/im.test(
      block,
    );
  const rulesetBranchPolicy = normalizeRulesetBranchPolicy(
    rulesets,
    branch,
    repositoryState.default_branch,
  );
  const branchPolicy = observePublicationSourceAuthorization(
    {
      protection,
      branch,
      rulesets,
      rulesetBranchPolicy,
      sourceSha,
      repository,
      branchState,
      publicationVersion,
      allowReleaseReconciliation,
      requiredStatusCheck,
    },
    { githubPublicJson },
  );
  const publisher = observePublisherAuthority({
    publisherMode,
    npmTrust,
    packageName,
    repository,
    publisherWorkflowPath,
    providerEnvironment,
    workflowPath,
    block,
    workflowText,
    providerAudit,
    longLivedWorkflowCredentialPresent,
  });

  return sealPublicationControlPlane({
    environmentState,
    block,
    repository,
    workflowPath,
    publisherWorkflowPath,
    environment,
    branch,
    packageName,
    publisherMode,
    requiredStatusCheck,
    explicitReadOnlyWorkflowPermissions,
    branchPolicy,
    environmentDeclared,
    deploymentBranches,
    environmentBranchAuthorized,
    environmentRefType,
    matchingEnvironmentPolicy,
    environmentRef,
    providerEnvironment,
    workflowText,
    publisher,
    oidc,
  });
}
