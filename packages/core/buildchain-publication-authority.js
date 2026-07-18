import fs from "node:fs";
import path from "node:path";

import { createPublicationAuthorityRegistry } from "./publication-authority.js";

const DESCRIPTORS = Object.freeze([
  [".github/workflows/.build.yml", "non-publication-oidc"],
  [".github/workflows/.release-candidate-promote.yml", "product-publication", true, ["npm-publish", "github-release", "channel-ref"], "trusted-publishing", "none", "fixed", "caller-bound"],
  [".github/workflows/.publication-authority.yml", "evidence-publication"],
  [".github/workflows/.release-verify.yml", "governance-write"],
  [".github/workflows/.sam-release.yml", "retired-deny"],
  [".github/workflows/.sam-verify.yml", "retired-deny"],
  [".github/workflows/.sync-remote-git.yml", "governance-write"],
  [".github/workflows/.web-surface.yml", "product-publication", true, ["web-production"], "oidc", "consumer-defined", "caller-bound", "caller-bound"],
  [".github/workflows/.wheel-release.yml", "retired-deny"],
  [".github/workflows/.wheel-verify.yml", "retired-deny"],
  [".github/workflows/.binary-release-assets.yml", "product-publication", true, ["github-release"], "github-token", "buildchain-release-assets"],
  [".github/workflows/binary-distribution.yml", "evidence-publication"],
  [".github/workflows/binary-release-assets.yml", "governance-write"],
  [".github/workflows/build-surface-fixture.yml", "non-publication-oidc"],
  [".github/workflows/build.yml", "non-publication-oidc"],
  [".github/workflows/buildchain-alpha-self-dogfood.yml", "non-publication-oidc"],
  [".github/workflows/buildchain-patrol-daily.yml", "governance-write"],
  [".github/workflows/buildchain-patrol-monthly.yml", "governance-write"],
  [".github/workflows/buildchain-patrol-weekly.yml", "governance-write"],
  [".github/workflows/buildchain-patrol.yml", "governance-write"],
  [".github/workflows/buildchain-ref-promotion.yml", "governance-write"],
  [".github/workflows/buildchain-stable-candidate-patrol.yml", "governance-write"],
  [".github/workflows/dev-merge-queue-governance.yml", "governance-write"],
  [".github/workflows/dev-pr-auto-merge.yml", "governance-write"],
  [".github/workflows/npm-publish.yml", "dry-run-only"],
  [".github/workflows/paper-release-sealed.yml", "product-publication", true, ["npm-publish", "github-release"], "trusted-publishing", "none", "fixed", "caller-bound"],
  [".github/workflows/paper-release.yml", "product-publication", true, ["npm-publish", "github-release"], "trusted-publishing", "none", "fixed", "caller-bound"],
  [".github/workflows/patrol-daily.yml", "governance-write"],
  [".github/workflows/patrol-monthly.yml", "governance-write"],
  [".github/workflows/patrol-weekly.yml", "governance-write"],
  [".github/workflows/publication-artifact.yml", "evidence-publication"],
  [".github/workflows/release-candidate-promote.yml", "product-publication", true, ["npm-publish", "github-release", "channel-ref"], "trusted-publishing", "none", "fixed", "caller-bound"],
  [".github/workflows/release-line-bootstrap.yml", "governance-write"],
  [".github/workflows/release-propagation.yml", "governance-write"],
  [".github/workflows/release-verify.yml", "governance-write"],
  [".github/workflows/stable-candidate-patrol.yml", "governance-write"],
]);

export function buildchainPublicationAuthorityDescriptors() {
  return DESCRIPTORS.map(([
    workflowPath,
    authorityClass,
    publicationCapable = false,
    capabilityIds = [],
    credentialMode = "none",
    environment = "",
    environmentMode = "fixed",
    publisherWorkflowMode = "fixed",
    publisherWorkflowPath = workflowPath,
  ]) => ({
    workflowPath,
    authorityClass,
    publicationCapable,
    capabilityIds,
    credentialMode,
    publisherWorkflowMode,
    publisherWorkflowPath,
    environment,
    environmentMode,
    runnerPolicy: publicationCapable ? "qualified-measured" : "unqualified",
  }));
}

export function createBuildchainPublicationAuthorityRegistry({ root = process.cwd() } = {}) {
  const workflowsDir = path.join(root, ".github", "workflows");
  const workflows = fs.readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => ({
      path: `.github/workflows/${name}`,
      text: fs.readFileSync(path.join(workflowsDir, name), "utf8"),
    }));
  return createPublicationAuthorityRegistry({
    descriptors: buildchainPublicationAuthorityDescriptors(),
    workflows,
  });
}
