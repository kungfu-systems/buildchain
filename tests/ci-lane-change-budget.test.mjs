import assert from "node:assert/strict";
import test from "node:test";
import {
  CI_LANE_CHANGE_BUDGET_CONTRACT,
  evaluateCiLaneChangeBudget,
} from "../packages/core/ci-lane-change-budget.js";

const workflow = `name: Check
on:
  pull_request:
  merge_group:
jobs:
  required:
    name: Required
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - run: true
`;

function policy(overrides = {}) {
  return {
    schema: CI_LANE_CHANGE_BUDGET_CONTRACT,
    baseline: { lanes: [] },
    declarations: [],
    ...overrides,
  };
}

function declaration(overrides = {}) {
  return {
    laneId: ".github/workflows/check.yml#required",
    authorityClass: "merge-critical-required",
    triggerClass: "mixed",
    concurrencyPolicy: {
      mode: "ref-scoped",
      cancelInProgress: true,
    },
    expectedRunnerMinutes: 3,
    cancellationBehavior: "cancel-stale",
    sloImpact: {
      mergeCritical: true,
      metric: "required-gate-latency",
      expectedContributionSeconds: 180,
      rationale: "The lane is a required merge-group Gate.",
    },
    ...overrides,
  };
}

test("legacy baseline lanes do not require retroactive declarations", () => {
  const result = evaluateCiLaneChangeBudget({
    policy: policy({
      baseline: { lanes: [".github/workflows/check.yml#required"] },
    }),
    workflows: [{ path: ".github/workflows/check.yml", text: workflow }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.newLaneCount, 0);
  assert.equal(result.declaredLaneCount, 0);
});

test("new lanes fail closed without a complete budget declaration", () => {
  const result = evaluateCiLaneChangeBudget({
    policy: policy(),
    workflows: [{ path: ".github/workflows/check.yml", text: workflow }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["undeclared-new-lane"],
  );
});

test("a complete exact-lane declaration admits the new lane", () => {
  const result = evaluateCiLaneChangeBudget({
    policy: policy({ declarations: [declaration()] }),
    workflows: [{ path: ".github/workflows/check.yml", text: workflow }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.newLanes, [".github/workflows/check.yml#required"]);
});

test("declarations reject trigger drift and incomplete SLO budgets", () => {
  const result = evaluateCiLaneChangeBudget({
    policy: policy({
      declarations: [
        declaration({
          triggerClass: "pull-request",
          sloImpact: { mergeCritical: true },
        }),
      ],
    }),
    workflows: [{ path: ".github/workflows/check.yml", text: workflow }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["invalid-slo-impact", "trigger-class-mismatch"],
  );
});

test("stale declarations cannot silently retain a removed lane", () => {
  const result = evaluateCiLaneChangeBudget({
    policy: policy({ declarations: [declaration()] }),
    workflows: [
      {
        path: ".github/workflows/check.yml",
        text: "on: push\njobs: {}\n",
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["stale-declaration"],
  );
});
