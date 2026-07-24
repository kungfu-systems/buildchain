import assert from "node:assert/strict";
import test from "node:test";
import {
  planReleaseGovernanceReconciliation,
  resolvePublicBuildRouterAggregateCheck,
} from "../scripts/reconcile-release-governance.mjs";

const SHA = "4fa074877b7263c1a32727eac4fb993c47776147";
const APP_ID = 15368;

function check(name, completedAt = "2026-07-21T00:00:00Z") {
  return {
    name,
    status: "completed",
    conclusion: "success",
    completed_at: completedAt,
    app: { id: APP_ID },
  };
}

function protection(contexts = ["build / Summarize build contract", "verify"]) {
  return {
    required_status_checks: {
      strict: true,
      contexts,
      checks: contexts.map((context) => ({ context, app_id: APP_ID })),
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 1 },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
}

test("reconciliation replaces a stale Buildchain aggregate and preserves unrelated protection", () => {
  const emitted =
    "build / Build with resolved channel / Summarize build contract";
  const plan = planReleaseGovernanceReconciliation({
    repository: "kungfu-systems/libnode",
    branch: "release/v22/v22.22",
    candidateSha: SHA,
    protection: protection(),
    checkRuns: [check(emitted)],
  });

  assert.equal(plan.expected.context, emitted);
  assert.deepEqual(plan.staleBuildchainContexts, [
    { context: "build / Summarize build contract", app_id: APP_ID },
  ]);
  assert.deepEqual(plan.requiredStatusChecks.after, [
    { context: "verify", app_id: APP_ID },
    { context: emitted, app_id: APP_ID },
  ]);
  assert.equal(plan.requiredStatusChecks.strict, true);
  assert.deepEqual(plan.preservedPolicy, {
    requiredApprovingReviewCount: 1,
    enforceAdmins: true,
    requiredConversationResolution: true,
    allowForcePushes: false,
    allowDeletions: false,
  });
  assert.equal(plan.changed, true);
});

test("the public router top-level aggregate wins over internal reusable workflow nesting", () => {
  const nested =
    "build / Build with resolved channel / Summarize build contract";
  const stable = "build / Summarize build contract";
  const resolved = resolvePublicBuildRouterAggregateCheck({
    checkRuns: [check(nested), check(stable, "2026-07-21T00:01:00Z")],
  });

  assert.deepEqual(resolved, { context: stable, app_id: APP_ID });
});

test("reconciliation is idempotent once the emitted aggregate is protected", () => {
  const stable = "build / Summarize build contract";
  const plan = planReleaseGovernanceReconciliation({
    repository: "kungfu-systems/libnode",
    branch: "release/v22/v22.22",
    candidateSha: SHA,
    protection: protection([stable]),
    checkRuns: [check(stable)],
  });

  assert.equal(plan.changed, false);
  assert.deepEqual(
    plan.requiredStatusChecks.before,
    plan.requiredStatusChecks.after,
  );
});

test("reconciliation fails closed when no successful router aggregate exists", () => {
  assert.throws(
    () =>
      planReleaseGovernanceReconciliation({
        repository: "kungfu-systems/libnode",
        branch: "release/v22/v22.22",
        candidateSha: SHA,
        protection: protection(),
        checkRuns: [
          {
            ...check("build / Summarize build contract"),
            conclusion: "failure",
          },
        ],
      }),
    /no successful public Buildchain aggregate/,
  );
});
