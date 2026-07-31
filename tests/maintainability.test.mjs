import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  analyzeJavaScript,
  collectMaintainabilityMetrics,
} from "../scripts/maintainability-metrics.mjs";
import {
  evaluatePublicSurface,
  evaluateMaintainability,
  sourceMetricsAtRevision,
} from "../scripts/check-maintainability.mjs";

const root = path.resolve(import.meta.dirname, "..");
const policy = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture", "maintainability-policy.json"),
    "utf8",
  ),
);
const baseline = JSON.parse(
  fs.readFileSync(path.join(root, policy.baseline), "utf8"),
);

test("exact-head maintainability baseline is reproducible", () => {
  const report = collectMaintainabilityMetrics({
    root,
    revision: baseline.revision,
  });
  assert.equal(report.revision, baseline.revision);
  assert.deepEqual(report.repository, baseline.repository);
  assert.deepEqual(report.publicSurface, baseline.publicSurface);
  assert.equal(report.hotspots.promoteBuildchainRefs.lines, 3066);
  assert.equal(report.hotspots.promoteBuildchainRefs.complexity, 262);
  assert.equal(report.hotspots.createReleaseCheckReport.lines, 470);
  assert.equal(report.hotspots.createReleaseCheckReport.complexity, 155);
});

test("AST complexity proxy counts bounded decisions without charging nested functions twice", () => {
  const metrics = analyzeJavaScript(
    "fixture.mjs",
    [
      "export function outer(value) {",
      "  if (value && value.ready) return value.ok ? 1 : 0;",
      "  const nested = () => value || null;",
      "  return nested();",
      "}",
    ].join("\n"),
  );
  assert.deepEqual(
    metrics.functions.map(({ name, lines, complexity }) => ({
      name,
      lines,
      complexity,
    })),
    [
      { name: "outer", lines: 5, complexity: 4 },
      { name: "nested", lines: 1, complexity: 2 },
    ],
  );
});

test("new-only budgets reject widened debt and oversized extracted units", () => {
  const baselineFiles = {
    "legacy.js": analyzeJavaScript(
      "legacy.js",
      `function legacy(v) {\n${"  if (v) v++;\n".repeat(11)}  return v;\n}\n`,
    ),
  };
  const current = {
    files: {
      "legacy.js": analyzeJavaScript(
        "legacy.js",
        `function legacy(v) {\n${"  if (v) v++;\n".repeat(12)}  return v;\n}\nfunction extracted(v) {\n${"  if (v) v++;\n".repeat(30)}}\n`,
      ),
      "new.js": analyzeJavaScript(
        "new.js",
        `function extracted(v) {\n${"  if (v) v++;\n".repeat(30)}}\n`,
      ),
    },
  };
  const fixturePolicy = structuredClone(policy);
  fixturePolicy.sourceBudgets.newFunctionComplexity = 10;
  fixturePolicy.selectedFunctionBudgets = {};
  const issues = evaluateMaintainability({
    current,
    baselineFiles,
    policy: fixturePolicy,
  });
  assert.ok(
    issues.some((entry) =>
      entry.includes("legacy.js: maximum function complexity widened"),
    ),
  );
  assert.ok(
    issues.some((entry) => entry.includes("extracted has complexity 31")),
  );
  assert.ok(
    issues.some((entry) =>
      entry.includes("new.js:1 extracted has complexity 31"),
    ),
  );
});

test("baseline revision source metrics remain available from Git", () => {
  const files = sourceMetricsAtRevision(root, baseline.revision);
  assert.equal(files["actions/promote-buildchain-ref/lib.js"].lines, 5854);
  assert.equal(files["packages/core/release-passport.js"].lines, 2577);
});

test("public surface lifecycle metadata preserves baseline contracts", () => {
  assert.deepEqual(
    evaluatePublicSurface({
      root,
      revision: policy.enforcementRevision || baseline.revision,
      policy,
    }),
    [],
  );
});
