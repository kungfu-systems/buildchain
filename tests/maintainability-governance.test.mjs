import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeJavaScript,
  analyzeRust,
  analyzeWorkflow,
} from "../scripts/maintainability-metrics.mjs";
import {
  evaluateDebtAuthority,
  evaluateExceptionGovernance,
  evaluateTestBudgets,
  evaluateWorkflowBudgets,
} from "../scripts/check-maintainability.mjs";
import { generateAgentChangeMap } from "../scripts/generate-agent-change-map.mjs";

test("Rust metrics count decisions while ignoring comments, strings, and nested functions", () => {
  const metrics = analyzeRust(
    "fixture.rs",
    String.raw`fn outer(value: bool) -> Result<i32, Error> {
  // if ignored { return Ok(0); }
  let ignored = r#"if ignored && ignored"#;
  fn nested(value: bool) -> i32 { if value { 1 } else { 0 } }
  if value && nested(value) > 0 { return Ok(1); }
  Err(error)?
}`,
  );
  assert.deepEqual(
    metrics.functions.map(({ name, lines, complexity }) => ({
      name,
      lines,
      complexity,
    })),
    [
      { name: "outer", lines: 7, complexity: 4 },
      { name: "nested", lines: 1, complexity: 2 },
    ],
  );
});

test("workflow metrics count jobs, steps, and decision nodes without shell text", () => {
  const metrics = analyzeWorkflow(
    "fixture.yml",
    `name: Fixture
on: push
jobs:
  build:
    strategy:
      matrix: { node: [20, 22] }
    steps:
      - run: |
          if hidden; then echo matrix; fi
      - if: success()
        run: echo ok
  verify:
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`,
  );
  assert.deepEqual(metrics, {
    lines: 16,
    jobs: 2,
    steps: 3,
    maxStepsPerJob: 2,
    decisions: 3,
  });
});

test("test and workflow budgets reject new oversized surfaces", () => {
  const testMetrics = analyzeJavaScript(
    "tests/fixture.test.mjs",
    `test("large", () => {\n${"  if (ready) run();\n".repeat(4)}});\n`,
  );
  assert.ok(
    evaluateTestBudgets({
      current: { tests: { "tests/fixture.test.mjs": testMetrics } },
      baselineFiles: {},
      policy: {
        testBudgets: {
          newFileLines: 4,
          newFunctionLines: 3,
          newFunctionComplexity: 3,
        },
      },
    }).length >= 2,
  );
  assert.deepEqual(
    evaluateWorkflowBudgets({
      current: {
        workflows: {
          ".github/workflows/fixture.yml": {
            lines: 20,
            jobs: 3,
            steps: 7,
            maxStepsPerJob: 5,
            decisions: 4,
          },
        },
      },
      baselineFiles: {},
      policy: {
        workflowBudgets: {
          maxLines: 10,
          maxJobs: 2,
          maxSteps: 6,
          maxStepsPerJob: 4,
          maxDecisions: 3,
        },
      },
    }).length,
    5,
  );
});

test("every maintainability exception has a live expiry or real debt reduction", () => {
  const base = {
    approvedExistingDebtTransitions: {
      "legacy.js": { maxLines: 20 },
    },
  };
  assert.match(
    evaluateExceptionGovernance({
      policy: base,
      now: new Date("2026-08-26"),
    })[0],
    /requires governance/u,
  );

  const expiring = structuredClone(base);
  expiring.approvedExistingDebtTransitions["legacy.js"].governance = {
    mode: "expiry",
    expiresOn: "2026-08-25",
    owner: "maintainers",
    followUp: "Remove the exception.",
  };
  assert.match(
    evaluateExceptionGovernance({
      policy: expiring,
      now: new Date("2026-08-26"),
    })[0],
    /expired/u,
  );

  const nonReducing = structuredClone(base);
  nonReducing.approvedExistingDebtTransitions["legacy.js"].governance = {
    mode: "net-debt-reduction",
    metrics: { maxLines: { baseline: 20, target: 20 } },
  };
  assert.match(
    evaluateExceptionGovernance({
      policy: nonReducing,
      now: new Date("2026-08-26"),
    })[0],
    /target must be lower/u,
  );

  const reducing = structuredClone(base);
  reducing.approvedExistingDebtTransitions["legacy.js"].maxLines = 18;
  reducing.approvedExistingDebtTransitions["legacy.js"].governance = {
    mode: "net-debt-reduction",
    metrics: { maxLines: { baseline: 20, target: 18 } },
  };
  assert.deepEqual(
    evaluateExceptionGovernance({
      policy: reducing,
      now: new Date("2026-08-26"),
    }),
    [],
  );
});

test("Agent change map preserves every maintenance edge", () => {
  const output = generateAgentChangeMap({
    capabilities: [
      {
        id: "fixture",
        owner: "maintainers",
        implementation: ["src/fixture.js"],
        contracts: ["contracts/fixture.json"],
        tests: ["tests/fixture.test.mjs"],
        generatedOutputs: ["dist/fixture.js"],
        validationCommands: ["node --test tests/fixture.test.mjs"],
      },
    ],
  });
  for (const expected of [
    "src/fixture.js",
    "contracts/fixture.json",
    "tests/fixture.test.mjs",
    "dist/fixture.js",
    "node --test tests/fixture.test.mjs",
  ]) {
    assert.match(output, new RegExp(expected.replaceAll(".", "\\."), "u"));
  }
});

test("complexity debt authority fails closed on missing, stale, widened, or split-only debt", () => {
  const current = {
    files: { "legacy.js": { lines: 10, functions: [] } },
    tests: {},
    workflows: {},
  };
  const policy = {
    sourceBudgets: {
      newFileLines: 5,
      newFunctionLines: 3,
      newFunctionComplexity: 2,
    },
    rustBudgets: {
      newFileLines: 5,
      newFunctionLines: 3,
      newFunctionComplexity: 2,
    },
    testBudgets: {
      newFileLines: 5,
      newFunctionLines: 3,
      newFunctionComplexity: 2,
    },
    workflowBudgets: {
      maxLines: 5,
      maxJobs: 1,
      maxSteps: 2,
      maxStepsPerJob: 2,
      maxDecisions: 1,
    },
  };
  const debt = {
    schemaVersion: 1,
    defaults: {
      owner: "maintainers",
      capability: "maintainability-governance",
      expiry: "2099-12-31",
      impact: "review radius",
      recovery: "focused tests",
      stopCondition: "behavior drift",
      invariant: "no widening",
      tests: ["fixture"],
      safeChangeRoute: "reduce then ratchet",
    },
    surfaces: {
      sources: {
        "legacy.js": {
          baseline: { lines: 11 },
          current: { lines: 10 },
          target: { lines: 5 },
        },
      },
      rust: {},
      tests: {},
      workflows: {},
    },
    hotspots: ["legacy.js"],
    burnDownSlices: [
      {
        domain: "sources",
        path: "legacy.js",
        metric: "lines",
        baseline: 11,
        current: 10,
      },
    ],
  };
  const evaluate = (value) =>
    evaluateDebtAuthority({
      current,
      policy,
      debt: value,
      capabilityIds: new Set(["maintainability-governance"]),
      hotspots: ["legacy.js"],
    });
  assert.deepEqual(evaluate(debt), []);
  for (const [mutate, expected] of [
    [(value) => delete value.surfaces.sources["legacy.js"], /undeclared/u],
    [
      (value) => {
        value.surfaces.sources["legacy.js"].current.lines = 9;
      },
      /measurement is stale/u,
    ],
    [
      (value) => {
        value.defaults.capability = "missing";
      },
      /capability is unmapped/u,
    ],
    [
      (value) => {
        value.defaults.expiry = "2020-01-01";
      },
      /expiry is invalid or stale/u,
    ],
    [
      (value) => {
        value.surfaces.sources["legacy.js"].target.lines = 10;
      },
      /target must be lower/u,
    ],
    [
      (value) => {
        value.surfaces.sources["legacy.js"].baseline.lines = 9;
      },
      /widened beyond baseline/u,
    ],
    [
      (value) => {
        value.burnDownSlices[0].baseline = 10;
      },
      /split-only/u,
    ],
  ]) {
    const fixture = structuredClone(debt);
    mutate(fixture);
    assert.ok(evaluate(fixture).some((issue) => expected.test(issue)));
  }
});
