import {
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryProtectedBase as protectedBase,
  devDeliveryRepository as repository,
  devDeliveryText as text,
} from "./dev-delivery-common.js";

export const DEV_DELIVERY_PROVIDER_ATTEMPT_SCHEMA =
  "kungfu.buildchain.github-landing-provider-attempt/v1";

function workflowPath(value) {
  const normalized = text(value);
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(normalized)) {
    throw new Error("provider workflow path must name a root workflow");
  }
  return normalized;
}

function workflowRef(value, path) {
  const normalized = text(value);
  if (
    !new RegExp(
      `^[^/\\s]+/[^/\\s]+/${path.replaceAll(".", "\\.")}@refs/(?:heads|tags)/[^\\s]+$`,
      "u",
    ).test(normalized)
  ) {
    throw new Error(
      "provider workflow ref must bind repository, path, and an exact heads or tags ref",
    );
  }
  return normalized;
}

function labels(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("provider runner labels must be a non-empty array");
  }
  const normalized = [...new Set(input.map(text).filter(Boolean))].sort();
  if (normalized.length === 0) {
    throw new Error("provider runner labels must contain exact labels");
  }
  return normalized;
}

export function assertDevDeliveryGitHubHostedRunner({
  runnerGroupName,
  runnerLabels,
} = {}) {
  const group = text(runnerGroupName);
  const exactLabels = labels(runnerLabels);
  if (
    group !== "GitHub Actions" ||
    exactLabels.some((label) => label.toLowerCase() === "self-hosted")
  ) {
    throw new Error(
      "provider authority requires the GitHub-hosted runner group",
    );
  }
  return { runnerGroupName: group, runnerLabels: exactLabels };
}

export function normalizeDevDeliveryProviderAttempt(input = {}, expected = {}) {
  if (input.schema !== DEV_DELIVERY_PROVIDER_ATTEMPT_SCHEMA) {
    throw new Error("Landing provider attempt schema is unsupported");
  }
  const exactWorkflowPath = workflowPath(input.workflowPath);
  const attempt = {
    schema: DEV_DELIVERY_PROVIDER_ATTEMPT_SCHEMA,
    repository: repository(input.repository),
    workflowId: positiveInteger(input.workflowId, "provider workflow id"),
    workflowPath: exactWorkflowPath,
    workflowRef: workflowRef(input.workflowRef, exactWorkflowPath),
    workflowSha: exactSha(input.workflowSha, "provider workflow SHA"),
    event: text(input.event),
    runId: positiveInteger(input.runId, "provider run id"),
    runAttempt: positiveInteger(input.runAttempt, "provider run attempt"),
    jobId: positiveInteger(input.jobId, "provider job id"),
    jobName: text(input.jobName),
    jobRole: text(input.jobRole),
    runnerId: positiveInteger(input.runnerId, "provider runner id"),
    runnerName: text(input.runnerName),
    runnerGroupId: positiveInteger(
      input.runnerGroupId,
      "provider runner group id",
    ),
    runnerGroupName: text(input.runnerGroupName),
    runnerLabels: labels(input.runnerLabels),
    sourceHead: exactSha(input.sourceHead, "provider source head"),
    mergeGroupHead: exactSha(input.mergeGroupHead, "provider merge-group head"),
    protectedBase: protectedBase(input.protectedBase),
  };
  if (attempt.event !== "merge_group") {
    throw new Error("Landing provider attempt event must be merge_group");
  }
  if (!attempt.jobName) throw new Error("provider job name is required");
  if (attempt.jobRole !== "landing-authority") {
    throw new Error("provider job role must be landing-authority");
  }
  if (!attempt.runnerName || !attempt.runnerGroupName) {
    throw new Error("provider runner identity is incomplete");
  }
  assertDevDeliveryGitHubHostedRunner(attempt);
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && attempt[field] !== value) {
      throw new Error(`Landing provider attempt ${field} mismatch`);
    }
  }
  return attempt;
}

export function normalizeDevDeliveryTerminalProviderEvidence(input = {}) {
  const evidence = {};
  if (input.providerAttempt) {
    evidence.providerAttempt = normalizeDevDeliveryProviderAttempt(
      input.providerAttempt,
    );
  }
  if (input.providerTerminalReadbackRoot) {
    evidence.providerTerminalReadbackRoot = exactRoot(
      input.providerTerminalReadbackRoot,
      "providerTerminalReadbackRoot",
    );
  }
  return evidence;
}
