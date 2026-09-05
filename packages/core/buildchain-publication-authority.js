import fs from "node:fs";
import path from "node:path";

import { createPublicationAuthorityRegistry } from "./publication-authority.js";

const DESCRIPTORS = Object.freeze([
  [".github/workflows/.auditable-demo.yml", "non-publication-oidc"],
  [".github/workflows/.declarative-auditable-demo.yml", "governance-write"],
  [".github/workflows/.build.yml", "non-publication-oidc"],
  [".github/workflows/.release-candidate-promote.yml", "product-publication", true, ["npm-publish", "github-release", "channel-ref"], "trusted-publishing", "none", "fixed", "caller-bound"],
  [".github/workflows/.publication-authority.yml", "evidence-publication"],
  [".github/workflows/.release-verify.yml", "governance-write"],
  [".github/workflows/.sam-verify.yml", "retired-deny"],
  [".github/workflows/.sync-remote-git.yml", "governance-write"],
  [".github/workflows/.web-surface.yml", "product-publication", true, ["web-production"], "oidc", "consumer-defined", "caller-bound", "caller-bound"],
  [".github/workflows/.wheel-verify.yml", "retired-deny"],
  [".github/workflows/.binary-release-assets.yml", "product-publication", true, ["github-release"], "github-token", "buildchain-release-assets"],
  [".github/workflows/self-build-binary-distribution.yml", "evidence-publication"],
  [".github/workflows/self-release-binary-assets.yml", "governance-write"],
  [".github/workflows/artifact-signing-authority.yml", "evidence-publication"],
  [".github/workflows/self-build-demo-dogfood.yml", "governance-write"],
  [".github/workflows/self-build-fixture.yml", "non-publication-oidc"],
  [".github/workflows/build.yml", "non-publication-oidc"],
  [".github/workflows/bootstrap.yml", "product-publication", true, ["universal-candidate-execution"], "caller-secrets", "none", "fixed", "caller-bound"],
  [".github/workflows/self-build-alpha-dogfood.yml", "non-publication-oidc"],
  [".github/workflows/self-ops-dev-delivery.yml", "governance-write"],
  [".github/workflows/self-ops-patrol-daily.yml", "governance-write"],
  [".github/workflows/self-ops-patrol-monthly.yml", "governance-write"],
  [".github/workflows/self-ops-patrol-weekly.yml", "governance-write"],
  [".github/workflows/buildchain-patrol.yml", "governance-write"],
  [".github/workflows/self-ops-promotion-recovery.yml", "governance-write"],
  [".github/workflows/self-release-promote.yml", "governance-write"],
  [".github/workflows/self-ops-stable-candidate-patrol.yml", "governance-write"],
  [".github/workflows/dev-qualification-patrol.yml", "governance-write"],
  [".github/workflows/dev-alpha-candidate-patrol.yml", "governance-write"],
  [".github/workflows/dev-delivery-warrant-close.yml", "governance-write"],
  [".github/workflows/dev-delivery-warrant-cancel.yml", "governance-write"],
  [".github/workflows/self-ops-merge-queue.yml", "governance-write"],
  [".github/workflows/dev-pr-auto-merge.yml", "governance-write"],
  [".github/workflows/self-ops-housekeeping-daily.yml", "governance-write"],
  [".github/workflows/self-ops-housekeeping-monthly.yml", "governance-write"],
  [".github/workflows/self-ops-housekeeping-weekly.yml", "governance-write"],
  [".github/workflows/engineering-housekeeper.yml", "governance-write"],
  [".github/workflows/self-ops-governance-audit.yml", "governance-write"],
  [".github/workflows/github-artifact-attestation.yml", "evidence-publication", true, ["github-artifact-attestation"], "oidc", "consumer-defined", "caller-bound", "caller-bound"],
  [".github/workflows/self-release-npm-dry-run.yml", "dry-run-only"],
  [".github/workflows/paper-release-sealed.yml", "product-publication", true, ["npm-publish", "github-release"], "trusted-publishing", "none", "fixed", "caller-bound"],
  [".github/workflows/paper-release.yml", "product-publication", true, ["npm-publish", "github-release"], "trusted-publishing", "none", "fixed", "caller-bound"],
  [".github/workflows/patrol-daily.yml", "governance-write"],
  [".github/workflows/patrol-monthly.yml", "governance-write"],
  [".github/workflows/patrol-observed-evidence.yml", "product-publication", true, ["observed-evidence-publication"], "oidc", "consumer-defined", "caller-bound", "caller-bound"],
  [".github/workflows/patrol-weekly.yml", "governance-write"],
  [".github/workflows/publication-artifact.yml", "evidence-publication"],
  [".github/workflows/release-candidate-promote.yml", "product-publication", true, ["npm-publish", "github-release", "channel-ref"], "trusted-publishing", "none", "fixed", "caller-bound"],
  [".github/workflows/self-release-line-open.yml", "governance-write"],
  [".github/workflows/release-propagation.yml", "governance-write"],
  [".github/workflows/release-tail.yml", "product-publication", true, ["artifact.publish", "signed-channel.commit", "release.activate", "released-evidence.synthesize"], "caller-secrets", "caller-bound", "caller-bound", "fixed"],
  [".github/workflows/self-build-release-verify-compat.yml", "governance-write"],
  [".github/workflows/stable-candidate-patrol.yml", "governance-write"],
  [".github/workflows/universal-bootstrap-recovery.yml", "product-publication", true, ["universal-candidate-execution"], "caller-secrets", "none", "fixed", "caller-bound"],
  [".github/workflows/self-ops-bootstrap-dogfood.yml", "product-publication", true, ["universal-candidate-execution"], "caller-secrets", "none", "fixed", "caller-bound"],
  [".github/workflows/self-release-tail-dogfood.yml", "product-publication", true, ["artifact.publish", "signed-channel.commit", "release.activate", "released-evidence.synthesize"], "caller-secrets", "none", "fixed", "fixed"],
]);

export function buildchainPublicationAuthorityDescriptors({ root = process.cwd() } = {}) {
  const descriptors = DESCRIPTORS.map(([
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
  const taxonomyPath = path.join(root, "architecture/workflow-taxonomy.json");
  if (!fs.existsSync(taxonomyPath)) return descriptors;
  const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, "utf8"));
  for (const entry of taxonomy.entries) {
    if (!entry.compatibility) continue;
    const previous = descriptors.find((item) => item.workflowPath === entry.compatibility.path);
    if (!previous) continue;
    const prefix = entry.role === "component" ? "." : `${entry.role}-`;
    const workflowPath = `.github/workflows/${prefix}${entry.category}-${entry.purpose}.yml`;
    if (fs.readFileSync(path.join(root, workflowPath), "utf8") !== fs.readFileSync(path.join(root, entry.compatibility.path), "utf8")) {
      throw new Error(`publication authority alias differs from canonical workflow: ${workflowPath}`);
    }
    descriptors.push({ ...previous, workflowPath, publisherWorkflowPath: previous.publisherWorkflowPath === previous.workflowPath ? workflowPath : previous.publisherWorkflowPath });
  }
  return descriptors;
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
    descriptors: buildchainPublicationAuthorityDescriptors({ root }),
    workflows,
  });
}
