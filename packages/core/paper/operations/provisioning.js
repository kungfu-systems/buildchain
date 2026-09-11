import { PAPER_PATHS, sha256Text, stableJson } from "../paper-repository.js";
import { PAPER_AGENT_ENTRY_CONTRACT } from "../paper-agent-entry.js";
import path from "node:path";
import {
  PAPER_PROVISIONING_CONTRACT,
  NPM_REGISTRY,
  DEFAULT_BOOTSTRAP_VERSION,
} from "./identity.js";
export function paperProvisioningPolicy() {
  return {
    repositoryActions: {
      defaultWorkflowPermissions: "read",
      canApprovePullRequestReviews: false,
    },
    generatedWrites: {
      preferredAuthority: "github-app",
      compatibilityAuthority: "narrow-token",
      githubTokenFallback: false,
      permissions: ["checks:write", "contents:write", "pull-requests:write"],
      tokenPersistence: "runtime-only",
    },
    release: {
      protectedReviewRequired: true,
      versionState: "not-required",
      identityOnlyPullRequests: false,
      manualVersionStateRepairPullRequests: false,
    },
    roles: {
      actor: "repository-development-role",
      pusher: "repository-development-role",
      reviewer: "independent-review-role",
      generatedWriteAuthority: "github-app-or-narrow-token",
    },
  };
}
export function createPaperProvisioningAuthority({
  repository,
  packageName,
  buildchainVersion,
  buildchainSha,
  contractLock,
  buildWorkflow,
  verifyWorkflow,
  releaseWorkflow,
  agentEntry,
  agentInstructions,
  environment = "",
}) {
  const policy = paperProvisioningPolicy();
  const payload = {
    schemaVersion: 1,
    contract: PAPER_PROVISIONING_CONTRACT,
    repository,
    package: {
      name: packageName,
      registry: NPM_REGISTRY,
      bootstrapVersion: DEFAULT_BOOTSTRAP_VERSION,
    },
    runtime: {
      repository: "kungfu-systems/buildchain",
      version: buildchainVersion,
      ref: buildchainSha,
      resolvedSha: buildchainSha,
    },
    workflows: {
      build: {
        path: PAPER_PATHS.buildWorkflow,
        sourceDigest: sha256Text(buildWorkflow),
        reusablePath: ".github/workflows/public-build-publication.yml",
        reusableRef: buildchainSha,
      },
      verify: {
        path: PAPER_PATHS.verifyWorkflow,
        sourceDigest: sha256Text(verifyWorkflow),
        reusablePath: ".github/workflows/public-build-check.yml",
        reusableRef: buildchainSha,
      },
      release: {
        path: PAPER_PATHS.releaseWorkflow,
        sourceDigest: sha256Text(releaseWorkflow),
        reusablePath: ".github/workflows/public-release-paper.yml",
        reusableRef: buildchainSha,
      },
    },
    agentEntry: {
      contract: PAPER_AGENT_ENTRY_CONTRACT,
      policyPath: PAPER_PATHS.agentEntry,
      policyDigest: sha256Text(agentEntry),
      instructionsPath: PAPER_PATHS.agentInstructions,
      instructionsDigest: sha256Text(agentInstructions),
    },
    admission: {
      contractLockPath: PAPER_PATHS.contractLock,
      contractLockDigest: sha256Text(contractLock),
      acceptedRef: buildchainSha,
      acceptedSha: buildchainSha,
    },
    trustedPublisher: {
      type: "github",
      repository,
      workflow: path.posix.basename(PAPER_PATHS.releaseWorkflow),
      environment,
    },
    policy: {
      ...policy,
      policyDigest: sha256Text(stableJson(policy)),
    },
  };
  return {
    ...payload,
    authorityDigest: sha256Text(stableJson(payload)),
  };
}
