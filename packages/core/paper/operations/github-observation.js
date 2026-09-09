import { commandResult } from "../paper-repository.js";
import { safeParseJson } from "./files.js";
export function liveRepositoryPermissionObservation(repository, cwd) {
  if (!repository) {
    return {
      status: "unknown",
      repository: "",
      canWrite: null,
      errorCode: "repository-unresolved",
    };
  }
  const result = commandResult("gh", ["api", `repos/${repository}`], { cwd });
  if (!result.ok) {
    return {
      status: "unknown",
      repository,
      canWrite: null,
      errorCode: result.error
        ? "gh-unavailable"
        : "github-permission-query-failed",
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      status: "unknown",
      repository,
      canWrite: null,
      errorCode: "github-response-invalid",
    };
  }
  const permissions = parsed.permissions || {};
  return {
    status: "observed",
    repository,
    canWrite: Boolean(
      permissions.push || permissions.maintain || permissions.admin,
    ),
    defaultBranch: parsed.default_branch || "",
    archived: parsed.archived === true,
    visibility: parsed.visibility || (parsed.private ? "private" : "public"),
    errorCode: "",
  };
}
export function liveRepositoryActionsPolicyObservation(repository, cwd) {
  if (!repository) {
    return {
      status: "unknown",
      defaultWorkflowPermissions: "",
      canApprovePullRequestReviews: null,
      errorCode: "repository-unresolved",
    };
  }
  const result = commandResult(
    "gh",
    ["api", `repos/${repository}/actions/permissions/workflow`],
    { cwd },
  );
  if (!result.ok) {
    return {
      status: "unknown",
      defaultWorkflowPermissions: "",
      canApprovePullRequestReviews: null,
      errorCode: result.error
        ? "gh-unavailable"
        : "github-actions-policy-query-failed",
    };
  }
  const parsed = safeParseJson(result.stdout);
  if (!parsed || typeof parsed !== "object") {
    return {
      status: "unknown",
      defaultWorkflowPermissions: "",
      canApprovePullRequestReviews: null,
      errorCode: "github-actions-policy-response-invalid",
    };
  }
  return {
    status: "observed",
    defaultWorkflowPermissions: String(
      parsed.default_workflow_permissions || "",
    ),
    canApprovePullRequestReviews:
      parsed.can_approve_pull_request_reviews === true,
    errorCode: "",
  };
}
export function liveGeneratedWriteAuthorityObservation(repository, cwd) {
  if (!repository) {
    return {
      status: "unknown",
      configured: null,
      mode: "",
      errorCode: "repository-unresolved",
    };
  }
  const result = commandResult(
    "gh",
    ["secret", "list", "--repo", repository, "--json", "name"],
    { cwd },
  );
  if (!result.ok) {
    return {
      status: "unknown",
      configured: null,
      mode: "",
      errorCode: result.error
        ? "gh-unavailable"
        : "github-secret-metadata-query-failed",
    };
  }
  const parsed = safeParseJson(result.stdout);
  const names = new Set(
    (Array.isArray(parsed) ? parsed : [])
      .map((entry) => String(entry?.name || ""))
      .filter(Boolean),
  );
  const appConfigured =
    names.has("BUILDCHAIN_GENERATED_WRITE_APP_CLIENT_ID") &&
    names.has("BUILDCHAIN_GENERATED_WRITE_APP_PRIVATE_KEY");
  const narrowTokenConfigured =
    names.has("BUILDCHAIN_GENERATED_WRITE_TOKEN") ||
    names.has("BUILDCHAIN_PROMOTION_TOKEN");
  return {
    status: "observed",
    configured: appConfigured || narrowTokenConfigured,
    mode: appConfigured
      ? "github-app"
      : narrowTokenConfigured
        ? "narrow-token"
        : "",
    errorCode: "",
  };
}
