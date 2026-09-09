import path from "node:path";
import {
  PAPER_PATHS,
  readJson,
  sha256Text,
  stableJson,
  normalizeRepository,
} from "../paper-repository.js";
import { PAPER_AGENT_ENTRY_CONTRACT } from "../paper-agent-entry.js";
import fs from "node:fs";
import { paperProvisioningWorkflowErrors } from "../paper-runtime-channels.js";
import {
  PAPER_PROVISIONING_CONTRACT,
  SHA256_PATTERN,
  GIT_SHA_PATTERN,
  NPM_REGISTRY,
  DEFAULT_BOOTSTRAP_VERSION,
} from "./identity.js";
import { sha256File, toPosix } from "./files.js";
export function validatePaperProvisioningAuthority(cwd) {
  const authorityPath = path.resolve(cwd, PAPER_PATHS.provisioningAuthority);
  const source = readJson(authorityPath);
  if (!source.exists) {
    return {
      exists: false,
      valid: false,
      value: undefined,
      errors: ["paper provisioning authority is missing"],
    };
  }
  if (source.error || !source.value) {
    return {
      exists: true,
      valid: false,
      value: source.value,
      errors: [source.error || "paper provisioning authority is invalid"],
    };
  }
  const value = source.value;
  const errors = [];
  const floating = /^v4(?:-alpha)?$/.test(value.runtime?.ref || "");
  if (value.contract !== PAPER_PROVISIONING_CONTRACT) {
    errors.push("paper provisioning authority contract mismatch");
  }
  const { authorityDigest, ...payload } = value;
  if (
    !SHA256_PATTERN.test(String(authorityDigest || "")) ||
    authorityDigest !== sha256Text(stableJson(payload))
  ) {
    errors.push("paper provisioning authority digest mismatch");
  }
  if (
    !GIT_SHA_PATTERN.test(String(value.runtime?.resolvedSha || "")) ||
    (!floating && value.runtime?.ref !== value.runtime?.resolvedSha) ||
    value.admission?.acceptedRef !== value.runtime?.ref ||
    value.admission?.acceptedSha !== value.runtime?.resolvedSha
  ) {
    errors.push("paper runtime and admission are not bound to one exact SHA");
  }
  if (
    value.package?.registry !== NPM_REGISTRY ||
    value.package?.bootstrapVersion !== DEFAULT_BOOTSTRAP_VERSION
  ) {
    errors.push(
      "paper npm bootstrap authority is not fixed to the official registry and bootstrap version",
    );
  }
  validatePaperProvisioningPolicy({ errors, value });
  if (value.agentEntry?.contract !== PAPER_AGENT_ENTRY_CONTRACT) {
    errors.push("paper agent-entry authority contract mismatch");
  }
  for (const [entryPath, expectedDigest] of [
    [value.agentEntry?.policyPath, value.agentEntry?.policyDigest],
    [value.agentEntry?.instructionsPath, value.agentEntry?.instructionsDigest],
  ]) {
    if (!entryPath || !SHA256_PATTERN.test(String(expectedDigest || ""))) {
      errors.push("paper agent-entry authority is incomplete");
      continue;
    }
    const absolute = path.resolve(cwd, entryPath);
    if (!fs.existsSync(absolute) || sha256File(absolute) !== expectedDigest) {
      errors.push(`paper agent-entry source digest mismatch: ${entryPath}`);
    }
  }
  errors.push(...paperProvisioningWorkflowErrors(cwd, value));
  return {
    exists: true,
    valid: errors.length === 0,
    value,
    errors,
  };
}
export function expectedPaperTrustedPublisher(authority, fallback = {}) {
  const value = authority?.trustedPublisher || {};
  return {
    type: String(value.type || "github").toLowerCase(),
    repository: normalizeRepository(
      value.repository || fallback.repository || "",
    ),
    workflow: toPosix(value.workflow || fallback.workflow || ""),
    environment: String(value.environment || fallback.environment || ""),
  };
}
export function normalizedTrustedPublisher(value) {
  return {
    type: String(value?.type || value?.provider || "")
      .trim()
      .toLowerCase()
      .replace(/^github-actions$/, "github"),
    repository: normalizeRepository(value?.repository || value?.repo || ""),
    workflow: toPosix(value?.workflow || value?.file || "").replace(/^\/+/, ""),
    environment: String(value?.environment || value?.env || "").trim(),
  };
}
export function trustedPublisherMatches(actual, expected) {
  const normalized = normalizedTrustedPublisher(actual);
  return (
    normalized.type === expected.type &&
    normalized.repository === expected.repository &&
    normalized.workflow === expected.workflow &&
    normalized.environment === expected.environment
  );
}

function validatePaperProvisioningPolicy({ errors, value }) {
  const policy = value.policy || {};
  const { policyDigest, ...policyPayload } = policy;
  if (
    !SHA256_PATTERN.test(String(policyDigest || "")) ||
    policyDigest !== sha256Text(stableJson(policyPayload))
  ) {
    errors.push("paper provisioning policy digest mismatch");
  }
  if (
    policy.repositoryActions?.defaultWorkflowPermissions !== "read" ||
    policy.repositoryActions?.canApprovePullRequestReviews !== false
  ) {
    errors.push("paper repository Actions policy is not least privilege");
  }
  if (
    policy.generatedWrites?.preferredAuthority !== "github-app" ||
    policy.generatedWrites?.githubTokenFallback !== false
  ) {
    errors.push("paper generated-write policy permits an unbounded authority");
  }
  if (
    policy.release?.versionState !== "not-required" ||
    policy.release?.identityOnlyPullRequests !== false ||
    policy.release?.manualVersionStateRepairPullRequests !== false
  ) {
    errors.push(
      "paper release policy permits avoidable bookkeeping pull requests",
    );
  }
}
