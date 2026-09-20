import { GIT_SHA_PATTERN } from "./identity.js";
export function paperPreflightLocalChecks({
  agentEntry,
  provisioning,
  validationError,
  source,
  toolchain,
  runtime,
  lockEvaluation,
}) {
  return [
    ...agentEntry.checks.map((entry) => ({
      ...entry,
      blocking: true,
      scope: "local",
    })),
    {
      id: "provisioning.authority",
      status: provisioning.valid ? "pass" : "fail",
      blocking: true,
      scope: "local",
      message: provisioning.valid
        ? "Paper runtime, callers, contract lock, trust target, and policy share one exact authority root."
        : provisioning.errors.join("; "),
    },
    {
      id: "config.publication",
      status: validationError ? "fail" : "pass",
      blocking: true,
      scope: "local",
      message:
        validationError ||
        "Publication config, digest-pinned toolchain, and verify lifecycle are valid.",
    },
    {
      id: "source.exact-commit",
      status:
        GIT_SHA_PATTERN.test(source.head) && source.clean ? "pass" : "fail",
      blocking: false,
      scope: "external-mutation",
      message: !GIT_SHA_PATTERN.test(source.head)
        ? "Repository HEAD is unresolved."
        : source.clean
          ? "Source is bound to a clean exact commit."
          : "Working tree is dirty; reproducibility admits committed bytes only.",
    },
    {
      id: "toolchain.pinned",
      status: toolchain.machineVerifiable ? "pass" : "fail",
      blocking: true,
      scope: "local",
      message: toolchain.machineVerifiable
        ? "Publication toolchain identity is digest-pinned."
        : "Publication toolchain is not a qualifying digest-pinned latex-docker toolchain.",
    },
    {
      id: "runtime.exact-source",
      status:
        runtime.version && GIT_SHA_PATTERN.test(runtime.resolvedSha)
          ? "pass"
          : "fail",
      blocking: true,
      scope: "local",
      message:
        runtime.version && GIT_SHA_PATTERN.test(runtime.resolvedSha)
          ? "Buildchain runtime is bound to an exact package version and source SHA."
          : "Buildchain runtime version or exact source SHA is unresolved.",
    },
    {
      id: "runtime.contract-lock",
      status: lockEvaluation.compatible ? "pass" : "fail",
      blocking: true,
      scope: "local",
      message: lockEvaluation.compatible
        ? `Buildchain runtime contract is ${lockEvaluation.status}.`
        : `Buildchain runtime contract is not admitted: ${(lockEvaluation.reasons || []).join("; ")}`,
    },
  ];
}
export function paperPreflightRepositoryChecks({
  repositoryPermissions,
  repositoryActions,
  generatedWriteAuthority,
}) {
  return [
    {
      id: "repository.write-permission",
      status:
        repositoryPermissions.canWrite === true
          ? "pass"
          : repositoryPermissions.canWrite === false
            ? "fail"
            : "unknown",
      blocking: false,
      scope: "external-mutation",
      message:
        repositoryPermissions.canWrite === true
          ? "Current GitHub identity can write the repository."
          : repositoryPermissions.canWrite === false
            ? "Current GitHub identity cannot write the repository."
            : `Repository permission is unknown (${repositoryPermissions.errorCode}).`,
    },
    {
      id: "repository.actions-policy",
      status:
        repositoryActions.defaultWorkflowPermissions === "read" &&
        repositoryActions.canApprovePullRequestReviews === false
          ? "pass"
          : repositoryActions.status === "observed"
            ? "fail"
            : "unknown",
      blocking: false,
      scope: "external-mutation",
      message:
        repositoryActions.defaultWorkflowPermissions === "read" &&
        repositoryActions.canApprovePullRequestReviews === false
          ? "Repository defaults workflow permissions to read and disables Actions pull-request approval."
          : repositoryActions.status === "observed"
            ? "Repository Actions policy is broader than the paper provisioning authority."
            : `Repository Actions policy is unknown (${repositoryActions.errorCode}).`,
    },
    {
      id: "repository.generated-write-authority",
      status:
        generatedWriteAuthority.configured === true
          ? "pass"
          : generatedWriteAuthority.configured === false
            ? "pending"
            : "unknown",
      blocking: false,
      scope: "external-mutation",
      message:
        generatedWriteAuthority.configured === true
          ? `Generated writes use ${generatedWriteAuthority.mode} metadata; no secret value was read.`
          : generatedWriteAuthority.configured === false
            ? "No GitHub App or compatible narrow generated-write credential is configured."
            : `Generated-write authority is unknown (${generatedWriteAuthority.errorCode}).`,
    },
  ];
}
export function paperPreflightPublicationChecks({ npm, status }) {
  return [
    {
      id: "npm.package",
      status:
        npm.package.exists === true
          ? "pass"
          : npm.package.exists === false
            ? "pending"
            : "unknown",
      blocking: false,
      scope: "external-mutation",
      message:
        npm.package.exists === true
          ? `npm package exists at ${npm.package.version}.`
          : npm.package.exists === false
            ? "npm package does not exist and requires bootstrap."
            : `npm package existence is unknown (${npm.package.errorCode}).`,
    },
    {
      id: "npm.trusted-publisher",
      status:
        npm.trust.configured === true
          ? "pass"
          : npm.trust.configured === false
            ? "pending"
            : "unknown",
      blocking: false,
      scope: "external-mutation",
      message:
        npm.trust.configured === true
          ? "npm reports exactly the expected repository, workflow, and environment Trusted Publisher binding."
          : npm.trust.configured === false
            ? "npm does not report the exact expected Trusted Publisher binding."
            : `npm Trusted Publisher status is unknown (${npm.trust.errorCode}).`,
    },
    {
      id: "build.reproducible",
      status:
        status.deterministicBuild.status === "qualifying" ? "pass" : "pending",
      blocking: false,
      scope: "local",
      message:
        status.deterministicBuild.status === "qualifying"
          ? "A qualifying two-clean-build receipt exists."
          : "No qualifying two-clean-build receipt exists for the exact source.",
    },
    {
      id: "release.state-conflicts",
      status: status.conflicts.length === 0 ? "pass" : "fail",
      blocking: true,
      scope: "local",
      message:
        status.conflicts.length === 0
          ? "No local release-state conflict was detected."
          : `${status.conflicts.length} release-state conflict(s) require repair.`,
    },
  ];
}
export function paperPreflightNextActions() {
  return [
    {
      id: "migrate-consumer-contract",
      command: "buildchain paper migrate --json",
      description:
        "Review migration of this legacy Paper repository to schema 2 and the shared normal/recovery caller pair. Historical receipts remain unchanged.",
    },
  ];
}
