import fs from "node:fs";
import path from "node:path";

import { createPublicationAuthorityRegistry } from "../publication/publication-authority.js";

const DESCRIPTORS = Object.freeze([
  [".github/workflows/public-release-oci-compose-preview.yml", "product-publication", true, ["oci-compose-preview"], "caller-secrets", "none", "fixed", "caller-bound"],
  [".github/workflows/.build-demo-adapter.yml", "non-publication-oidc"],
  [".github/workflows/public-build-demo.yml", "governance-write"],
  [".github/workflows/.build.yml", "non-publication-oidc"],
  [".github/workflows/.release-promote.yml", "product-publication", true, ["npm-publish", "github-release", "channel-ref"], "trusted-publishing", "none", "fixed", "caller-bound"],
  [".github/workflows/.release-authority.yml", "evidence-publication"],
  [".github/workflows/.build-release-verify-compat.yml", "governance-write"],
  [".github/workflows/.build-sam-verify-compat.yml", "retired-deny"],
  [".github/workflows/.ops-git-sync.yml", "governance-write"],
  [".github/workflows/public-release-web.yml", "product-publication", true, ["web-production"], "oidc", "consumer-defined", "caller-bound", "caller-bound"],
  [".github/workflows/.build-wheel-verify-compat.yml", "retired-deny"],
  [".github/workflows/.release-binary-assets.yml", "product-publication", true, ["github-release"], "github-token", "buildchain-release-assets"],
  [".github/workflows/self-build-binary-distribution.yml", "evidence-publication"],
  [".github/workflows/self-release-binary-assets.yml", "governance-write"],
  [".github/workflows/public-release-signing-authority.yml", "evidence-publication"],
  [".github/workflows/self-build-demo-dogfood.yml", "governance-write"],
  [".github/workflows/self-build-fixture.yml", "non-publication-oidc"],
  [".github/workflows/build.yml", "non-publication-oidc"],
  [".github/workflows/public-ops-bootstrap.yml", "product-publication", true, ["universal-candidate-execution"], "caller-secrets", "none", "fixed", "caller-bound"],
  [".github/workflows/self-build-alpha-dogfood.yml", "non-publication-oidc"],
  [".github/workflows/self-build-stable-dogfood.yml", "non-publication-oidc"],
  [".github/workflows/self-ops-dev-delivery.yml", "governance-write"],
  [".github/workflows/self-ops-patrol-daily.yml", "governance-write"],
  [".github/workflows/self-ops-patrol-monthly.yml", "governance-write"],
  [".github/workflows/self-ops-patrol-weekly.yml", "governance-write"],
  [".github/workflows/public-ops-patrol.yml", "governance-write"],
  [".github/workflows/self-ops-promotion-recovery.yml", "governance-write"],
  [".github/workflows/self-release-promote.yml", "governance-write"],
  [".github/workflows/self-ops-stable-candidate-patrol.yml", "governance-write"],
  [".github/workflows/public-ops-dev-qualification-patrol.yml", "governance-write"],
  [".github/workflows/public-ops-alpha-candidate-patrol.yml", "governance-write"],
  [".github/workflows/public-ops-warrant-close.yml", "governance-write"],
  [".github/workflows/public-ops-warrant-cancel.yml", "governance-write"],
  [".github/workflows/self-ops-merge-queue.yml", "governance-write"],
  [".github/workflows/public-ops-dev-auto-merge.yml", "governance-write"],
  [".github/workflows/public-ops-pipeline.yml", "product-publication", true, ["npm-publish", "github-release", "channel-ref"], "trusted-publishing", "none", "fixed", "fixed", ".github/workflows/.release-pipeline-products.yml"],
  [".github/workflows/.release-pipeline-products.yml", "product-publication", true, ["npm-publish", "github-release", "channel-ref"], "trusted-publishing", "none", "fixed", "fixed"],
  [".github/workflows/.ops-pipeline-delivery.yml", "governance-write"],
  [".github/workflows/self-ops-housekeeping-daily.yml", "governance-write"],
  [".github/workflows/self-ops-housekeeping-monthly.yml", "governance-write"],
  [".github/workflows/self-ops-housekeeping-weekly.yml", "governance-write"],
  [".github/workflows/public-ops-housekeeping.yml", "governance-write"],
  [".github/workflows/self-ops-governance-audit.yml", "governance-write"],
  [".github/workflows/public-release-artifact-attestation.yml", "evidence-publication", true, ["github-artifact-attestation"], "oidc", "consumer-defined", "caller-bound", "caller-bound"],
  [".github/workflows/self-release-npm-dry-run.yml", "dry-run-only"],
  [".github/workflows/public-release-paper.yml", "product-publication", true, ["npm-publish", "github-release"], "trusted-publishing", "none", "fixed", "caller-bound"],
  [".github/workflows/public-ops-patrol-daily.yml", "governance-write"],
  [".github/workflows/public-ops-patrol-monthly.yml", "governance-write"],
  [".github/workflows/public-ops-observed-evidence.yml", "product-publication", true, ["observed-evidence-publication"], "oidc", "consumer-defined", "caller-bound", "caller-bound"],
  [".github/workflows/public-ops-patrol-weekly.yml", "governance-write"],
  [".github/workflows/public-build-publication.yml", "evidence-publication"],
  [".github/workflows/public-release-promote.yml", "product-publication", true, ["npm-publish", "github-release", "channel-ref"], "trusted-publishing", "none", "fixed", "caller-bound"],
  [".github/workflows/self-release-line-open.yml", "governance-write"],
  [".github/workflows/public-release-propagation.yml", "governance-write"],
  [".github/workflows/public-release-tail.yml", "product-publication", true, ["artifact.publish", "signed-channel.commit", "release.activate", "released-evidence.synthesize"], "caller-secrets", "caller-bound", "caller-bound", "fixed"],
  [".github/workflows/self-build-release-verify-compat.yml", "governance-write"],
  [".github/workflows/public-ops-stable-candidate-patrol.yml", "governance-write"],
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
