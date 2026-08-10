import {
  assertPlainObject,
  assertString,
  normalizeChannel,
  sha256Json,
} from "./release-propagation-common.js";
import { verifyReleasePropagationWork } from "./release-propagation-work.js";

export const SITE_UPSTREAM_AGENT_ENTRY_CONTRACT =
  "kungfu-buildchain-site-upstream-agent-entry";
export const RELEASE_PROPAGATION_FAILURE_MATRIX_CONTRACT =
  "kungfu-buildchain-release-propagation-failure-matrix";

const SOURCE_ALIASES = new Map([
  ["buildchain", "buildchain"],
  ["core", "kungfu-core"],
  ["kfd", "kfd"],
  ["kungfu", "kungfu-core"],
  ["kungfu-core", "kungfu-core"],
  ["paper", "paper"],
  ["papers", "paper"],
]);

const POLICIES = Object.freeze({
  buildchain: Object.freeze({
    mode: "downstream-manual",
    trigger: "explicit-site-intent",
    package: "@kungfu-tech/buildchain",
  }),
  "kungfu-core": Object.freeze({
    mode: "downstream-manual",
    trigger: "explicit-site-intent",
    package: "@kungfu-tech/site",
  }),
  kfd: Object.freeze({
    mode: "automatic-release-handoff",
    trigger: "upstream-release-capture",
    package: "@kungfu-tech/kfd",
  }),
  paper: Object.freeze({
    mode: "automatic-release-handoff",
    trigger: "upstream-release-capture",
    packagePrefix: "@kungfu-tech/paper-",
  }),
});

const FAILURE_ROWS = Object.freeze([
  ["current", "no-op", "none", "retain-current-cut"],
  ["duplicate-work", "no-op", "reuse", "resume-exact-work"],
  ["superseded-work", "stop", "needs-decision", "follow-declared-successor"],
  ["stale-downstream-base", "failure", "retry", "refresh-and-recapture"],
  ["stale-expected-old", "failure", "retry", "refresh-and-recapture"],
  [
    "package-schema-mismatch",
    "failure",
    "hard-safety-gate",
    "repair-upstream-release",
  ],
  ["pull-request-conflict", "failure", "retry", "refresh-and-recapture"],
  ["verification-failure", "failure", "retry", "repair-same-work"],
  ["release-race", "failure", "retry", "read-authoritative-release-and-resume"],
  ["deployment-failure", "failure", "retry", "repair-same-work"],
  ["online-readback-failure", "failure", "retry", "repair-same-work"],
]);

export const RELEASE_PROPAGATION_FAILURE_MATRIX = Object.freeze({
  schemaVersion: 1,
  contract: RELEASE_PROPAGATION_FAILURE_MATRIX_CONTRACT,
  rows: FAILURE_ROWS.map(([condition, outcome, disposition, recovery]) => ({
    condition,
    outcome,
    disposition,
    recovery,
  })),
});

export function normalizeSiteUpstreamIntent(value) {
  const raw = assertString(value, "site upstream intent").toLowerCase();
  if (raw.startsWith("@kungfu-tech/paper-")) return "paper";
  const normalized = SOURCE_ALIASES.get(raw);
  if (!normalized) {
    throw new Error(
      "site upstream intent must identify paper, kfd, buildchain, or kungfu-core",
    );
  }
  return normalized;
}

function automaticHandoff(sourceId, policy, handoffWork) {
  if (handoffWork === null || handoffWork === undefined) {
    return {
      status: "handoff-required",
      exactRelease: null,
      work: null,
      nextAction: {
        action: "consume-release-handoff",
        command:
          "buildchain release-propagation entry plan --source-id <source> --handoff-work <work.json> --json",
      },
    };
  }
  const status = verifyReleasePropagationWork(
    assertPlainObject(handoffWork, "automatic release handoff Work"),
  );
  const packageFact = status.work.upstream.release.package;
  const packageMatches =
    packageFact?.name === policy.package ||
    (policy.packagePrefix &&
      packageFact?.name?.startsWith(policy.packagePrefix));
  if (!packageMatches) {
    throw new Error(
      `automatic ${sourceId} handoff package disagrees with the selected policy`,
    );
  }
  return {
    status: status.lifecycle === "complete" ? "complete" : "handoff-ready",
    exactRelease: {
      repository: status.work.upstream.release.repository,
      package: packageFact,
      releaseRoot: status.work.upstream.releaseRoot,
    },
    work: {
      workId: status.workId,
      workRoot: status.contentRoot,
      lifecycle: status.lifecycle,
      currentStage: status.currentStage,
      expectedBaseSha: status.work.downstream.expectedBaseSha,
      branch: status.work.downstream.branch,
    },
    nextAction: status.nextAction,
  };
}

export function planSiteUpstreamAgentEntry({
  sourceId: sourceInput,
  channel = "",
  handoffWork = null,
} = {}) {
  const sourceId = normalizeSiteUpstreamIntent(sourceInput);
  const policy = POLICIES[sourceId];
  const normalizedChannel = channel
    ? normalizeChannel(channel, "site upstream channel")
    : sourceId === "paper" || sourceId === "kfd"
      ? ""
      : "release";
  const route =
    policy.mode === "automatic-release-handoff"
      ? automaticHandoff(sourceId, policy, handoffWork)
      : {
          status: "manual-resolution-required",
          exactRelease: null,
          work: null,
          nextAction: {
            action: "resolve-published-release",
            command: `buildchain release-propagation pickup plan --config <config.json> --source-id ${sourceId} --channel ${normalizedChannel} --current-version <exact-version> --json`,
          },
        };
  const body = {
    schemaVersion: 1,
    contract: SITE_UPSTREAM_AGENT_ENTRY_CONTRACT,
    sourceId,
    channel: normalizedChannel,
    policy,
    automaticTrigger: policy.mode === "automatic-release-handoff",
    ...route,
    faultMatrixRoot: sha256Json(RELEASE_PROPAGATION_FAILURE_MATRIX),
  };
  return { ...body, entryRoot: sha256Json(body) };
}

export function classifyReleasePropagationCondition(condition) {
  const normalized = assertString(condition, "release propagation condition");
  const row = RELEASE_PROPAGATION_FAILURE_MATRIX.rows.find(
    (entry) => entry.condition === normalized,
  );
  if (!row) {
    throw new Error(`unsupported release propagation condition: ${normalized}`);
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-propagation-condition",
    ...row,
    matrixRoot: sha256Json(RELEASE_PROPAGATION_FAILURE_MATRIX),
  };
}
