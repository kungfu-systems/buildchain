export function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

export function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function terminalEvidenceOptions(rest, environment) {
  return {
    outcome: flag(rest, "outcome", environment.BUILDCHAIN_DEV_DELIVERY_OUTCOME),
    eventAction: flag(
      rest,
      "event-action",
      environment.BUILDCHAIN_DEV_DELIVERY_EVENT_ACTION,
    ),
    evidenceRoot: flag(
      rest,
      "evidence-root",
      environment.BUILDCHAIN_DEV_DELIVERY_EVIDENCE_ROOT,
    ),
    expectedPriorEvidenceRoot: flag(
      rest,
      "expected-prior-evidence-root",
      environment.BUILDCHAIN_DEV_DELIVERY_EXPECTED_PRIOR_EVIDENCE_ROOT,
    ),
    integrationProofPath: flag(
      rest,
      "integration-proof",
      environment.BUILDCHAIN_DEV_DELIVERY_INTEGRATION_PROOF,
    ),
  };
}

function authorityStateOptions(rest, environment) {
  return {
    branch: flag(
      rest,
      "branch",
      environment.BUILDCHAIN_DEV_DELIVERY_BRANCH || environment.GITHUB_BASE_REF,
    ),
    stateRef: flag(
      rest,
      "state-ref",
      environment.BUILDCHAIN_DEV_DELIVERY_STATE_REF,
    ),
    expectedOldStateRoot: flag(
      rest,
      "expected-old",
      environment.BUILDCHAIN_DEV_DELIVERY_EXPECTED_OLD,
    ),
    legacyTerminalRecoveryPath: flag(
      rest,
      "legacy-terminal-recovery",
      environment.BUILDCHAIN_DEV_DELIVERY_LEGACY_TERMINAL_RECOVERY,
    ),
  };
}

export function devDeliveryCliOptions(args = [], environment = process.env) {
  const [command = "", ...rest] = args;
  return {
    command,
    repository: flag(rest, "repository", environment.GITHUB_REPOSITORY),
    ...authorityStateOptions(rest, environment),
    pullRequestNumber: flag(
      rest,
      "pull-request",
      environment.BUILDCHAIN_DEV_DELIVERY_PR_NUMBER,
    ),
    candidateId: flag(
      rest,
      "candidate-id",
      environment.BUILDCHAIN_DEV_DELIVERY_CANDIDATE_ID,
    ),
    sourceHead: flag(
      rest,
      "source-head",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_HEAD,
    ),
    expectedSourceHead: flag(
      rest,
      "expected-source-head",
      environment.BUILDCHAIN_DEV_DELIVERY_EXPECTED_SOURCE_HEAD,
    ),
    observedSourceHead: flag(
      rest,
      "observed-source-head",
      environment.BUILDCHAIN_DEV_DELIVERY_OBSERVED_SOURCE_HEAD,
    ),
    assignmentRoot: flag(
      rest,
      "assignment-root",
      environment.BUILDCHAIN_DEV_DELIVERY_ASSIGNMENT_ROOT,
    ),
    initiativeRoot: flag(
      rest,
      "initiative-root",
      environment.BUILDCHAIN_DEV_DELIVERY_INITIATIVE_ROOT,
    ),
    sourceIdentityRoot: flag(
      rest,
      "source-identity-root",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_IDENTITY_ROOT,
    ),
    sourcePatchRoot: flag(
      rest,
      "source-patch-root",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PATCH_ROOT,
    ),
    sourceProofRoot: flag(
      rest,
      "source-proof-root",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PROOF_ROOT,
    ),
    reuseActiveSourceProof: hasFlag(rest, "reuse-active-source-proof"),
    sourceWorkflowRunId: flag(
      rest,
      "source-workflow-run-id",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_WORKFLOW_RUN_ID,
    ),
    affectedPaths: flag(
      rest,
      "affected-paths-json",
      environment.BUILDCHAIN_DEV_DELIVERY_AFFECTED_PATHS || "[]",
    ),
    shardEvidenceRoots: flag(
      rest,
      "shard-evidence-roots-json",
      environment.BUILDCHAIN_DEV_DELIVERY_SHARD_EVIDENCE_ROOTS || "[]",
    ),
    nativeCommand: flag(
      rest,
      "native-command",
      environment.BUILDCHAIN_DEV_DELIVERY_NATIVE_COMMAND,
    ),
    nativeCommandRoot: flag(
      rest,
      "native-command-root",
      environment.BUILDCHAIN_DEV_DELIVERY_NATIVE_COMMAND_ROOT,
    ),
    releaseBlockerPriority: flag(
      rest,
      "release-blocker-priority-json",
      environment.BUILDCHAIN_DEV_DELIVERY_RELEASE_BLOCKER_PRIORITY,
    ),
    nativeProofPath: flag(
      rest,
      "native-proof",
      environment.BUILDCHAIN_DEV_DELIVERY_NATIVE_PROOF,
    ),
    nativeReuseDecisionPath: flag(
      rest,
      "native-reuse-decision",
      environment.BUILDCHAIN_DEV_DELIVERY_NATIVE_REUSE_DECISION,
    ),
    currentBase: flag(
      rest,
      "current-base",
      environment.BUILDCHAIN_DEV_DELIVERY_CURRENT_BASE,
    ),
    changedPaths: flag(
      rest,
      "changed-paths-json",
      environment.BUILDCHAIN_DEV_DELIVERY_CHANGED_PATHS || "[]",
    ),
    graphKnown: ["1", "true", "yes", "on"].includes(
      flag(rest, "graph-known", environment.BUILDCHAIN_DEV_DELIVERY_GRAPH_KNOWN)
        .trim()
        .toLowerCase(),
    ),
    attributionComplete: ["1", "true", "yes", "on"].includes(
      flag(
        rest,
        "attribution-complete",
        environment.BUILDCHAIN_DEV_DELIVERY_ATTRIBUTION_COMPLETE,
      )
        .trim()
        .toLowerCase(),
    ),
    renames: flag(
      rest,
      "renames-json",
      environment.BUILDCHAIN_DEV_DELIVERY_RENAMES || "[]",
    ),
    planRoot: flag(
      rest,
      "plan-root",
      environment.BUILDCHAIN_DEV_DELIVERY_PLAN_ROOT,
    ),
    closureRoot: flag(
      rest,
      "closure-root",
      environment.BUILDCHAIN_DEV_DELIVERY_CLOSURE_ROOT,
    ),
    dependencyRoot: flag(
      rest,
      "dependency-root",
      environment.BUILDCHAIN_DEV_DELIVERY_DEPENDENCY_ROOT,
    ),
    toolchainRoot: flag(
      rest,
      "toolchain-root",
      environment.BUILDCHAIN_DEV_DELIVERY_TOOLCHAIN_ROOT,
    ),
    environmentRoot: flag(
      rest,
      "environment-root",
      environment.BUILDCHAIN_DEV_DELIVERY_ENVIRONMENT_ROOT,
    ),
    deliveryClass: flag(
      rest,
      "delivery-class",
      environment.BUILDCHAIN_DEV_DELIVERY_CLASS,
    ),
    priority: flag(
      rest,
      "priority",
      environment.BUILDCHAIN_DEV_DELIVERY_PRIORITY || "ordinary",
    ),
    fencingToken: flag(
      rest,
      "fencing-token",
      environment.BUILDCHAIN_DEV_DELIVERY_FENCING_TOKEN,
    ),
    leaseGeneration: flag(
      rest,
      "lease-generation",
      environment.BUILDCHAIN_DEV_DELIVERY_LEASE_GENERATION,
    ),
    leaseSeconds: flag(
      rest,
      "lease-seconds",
      environment.BUILDCHAIN_DEV_DELIVERY_LEASE_SECONDS,
    ),
    ...terminalEvidenceOptions(rest, environment),
    transferRoot: flag(rest, "transfer-root"),
    finalizerBoundaryRoot: flag(rest, "finalizer-boundary-root"),
    nativeJobId: flag(rest, "native-job-id"),
    sealJobId: flag(rest, "seal-job-id"),
    reason: flag(rest, "reason", environment.BUILDCHAIN_DEV_DELIVERY_REASON),
    readMode: flag(
      rest,
      "read-mode",
      environment.BUILDCHAIN_V4_WARRANT_READ_MODE || "v3",
    ),
    readQualificationPath: flag(
      rest,
      "read-qualification",
      environment.BUILDCHAIN_V4_WARRANT_READ_QUALIFICATION,
    ),
    readQualificationRoot: flag(
      rest,
      "read-qualification-root",
      environment.BUILDCHAIN_V4_WARRANT_READ_QUALIFICATION_ROOT,
    ),
    readTypescriptRevision: flag(
      rest,
      "read-typescript-revision",
      environment.BUILDCHAIN_V4_WARRANT_TYPESCRIPT_REVISION,
    ),
    readRustRevision: flag(
      rest,
      "read-rust-revision",
      environment.BUILDCHAIN_V4_WARRANT_RUST_REVISION,
    ),
    readValidatorVersion: flag(
      rest,
      "read-validator-version",
      environment.BUILDCHAIN_V4_WARRANT_VALIDATOR_VERSION,
    ),
    readTimeoutMs: flag(
      rest,
      "read-timeout-ms",
      environment.BUILDCHAIN_V4_WARRANT_READ_TIMEOUT_MS || "5000",
    ),
    readEvidenceOutput: flag(
      rest,
      "read-evidence-output",
      environment.BUILDCHAIN_V4_WARRANT_READ_EVIDENCE ||
        ".buildchain/dev-delivery/v4-read-evidence.json",
    ),
    now: flag(rest, "now", environment.BUILDCHAIN_DEV_DELIVERY_NOW),
    outputPath: flag(
      rest,
      "output",
      environment.BUILDCHAIN_DEV_DELIVERY_OUTPUT ||
        ".buildchain/dev-delivery/result.json",
    ),
    execute: hasFlag(rest, "execute"),
    json: hasFlag(rest, "json"),
  };
}
