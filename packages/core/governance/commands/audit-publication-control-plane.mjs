#!/usr/bin/env node
import { auditPublicationControlPlane } from "../publication/audit.js";
import { readJsonValue, readSanitizedProviderAudit } from "../publication/policy-values.js";
const flag = (name, fallback = "") => process.argv.includes(`--${name}`) ? String(process.argv[process.argv.indexOf(`--${name}`) + 1] || "") : fallback;
try {
  const repository = flag("repository");
  const workflowRepository = flag("workflow-repository", repository);
  const workflowPath = flag("workflow", ".github/workflows/public-release-promote.yml");
  const workflowRef = flag("workflow-ref");
  const publisherWorkflowPath = flag("publisher-workflow", workflowPath);
  const requiredStatusCheck = flag("required-status-check", "check");
  const jobId = flag("job", "promote");
  const environment = flag("environment", "none");
  const branch = flag("branch");
  const environmentRef = flag("environment-ref", branch);
  const environmentRefType = flag("environment-ref-type", "branch");
  const sourceSha = flag("source-sha").toLowerCase();
  const packageName = flag("package", "@kungfu-tech/buildchain");
  const publisherMode = flag("publisher-mode", "npm-trusted-publisher");
  const publicationVersion = flag("publication-version");
  const allowReleaseReconciliation = process.argv.includes("--allow-release-reconciliation");
 const receipt = auditPublicationControlPlane({ repository, workflowRepository, workflowPath, workflowRef, publisherWorkflowPath, requiredStatusCheck, jobId, environment, branch, environmentRef, environmentRefType,
 sourceSha, packageName, publisherMode, publicationVersion, allowReleaseReconciliation, npmTrust: readJsonValue(flag("npm-trust-json"), "--npm-trust-json"), providerAudit: publisherMode === "oidc-role" ? readSanitizedProviderAudit(flag("provider-audit-json")) : null,
 token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN, publicReadToken: process.env.BUILDCHAIN_GITHUB_PUBLIC_READ_TOKEN }, { outputPath: flag("output"), allowNonqualifying: process.argv.includes("--allow-nonqualifying") });
 if (!flag("output")) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} catch (error) { console.error(`publication control-plane audit: ${error.message}`); process.exitCode = 1; }
