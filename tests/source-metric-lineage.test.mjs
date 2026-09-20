import { analyzeWorkflow } from "../scripts/maintainability-metrics.mjs";
import { evaluateWorkflowBudgets } from "../scripts/check-maintainability.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  projectRenamedMetrics,
  projectWorkflowMetrics,
} from "../scripts/source-metric-lineage.mjs";

test("metric inheritance follows an observed Git rename, never a copy or unrelated target", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-metric-lineage-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "--quiet");
  fs.writeFileSync(
    path.join(root, "source.mjs"),
    "export const uniqueSource = 1;\n",
  );
  fs.writeFileSync(
    path.join(root, "retained.mjs"),
    "export const retainedSource = 2;\n",
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const revision = git("rev-parse", "HEAD").trim();
  const target = "nested/renamed module.mjs";
  fs.mkdirSync(path.join(root, "nested"));
  git("mv", "source.mjs", target);
  fs.copyFileSync(
    path.join(root, "retained.mjs"),
    path.join(root, "copied.mjs"),
  );
  git("add", ".");
  const sourceMetric = { file: "source.mjs", sourceLines: 42 };
  const metrics = {
    "source.mjs": sourceMetric,
    "retained.mjs": { sourceLines: 7 },
  };
  const currentPaths = new Set([target, "retained.mjs", "copied.mjs"]);
  const result = projectRenamedMetrics({
    root,
    revision,
    metrics,
    currentPaths,
  });
  assert.deepEqual(result.renames, [
    { source: "source.mjs", target, similarity: 100 },
  ]);
  assert.deepEqual(result.metrics[target], { ...sourceMetric, file: target });
  assert.equal(result.metrics["copied.mjs"], undefined);
  assert.deepEqual(metrics["source.mjs"], sourceMetric);
  assert.equal(metrics[target], undefined);
  assert.deepEqual(
    projectRenamedMetrics({ root, revision, metrics, currentPaths: new Set() })
      .renames,
    [],
  );
  const existing = { sourceLines: 3 };
  const priorTarget = projectRenamedMetrics({
    root,
    revision,
    metrics: { ...metrics, [target]: existing },
    currentPaths,
  });
  assert.deepEqual(priorTarget.renames, []);
  assert.equal(priorTarget.metrics[target], existing);
});

test("workflow renames preserve measured debt while any new job still fails the inherited ceiling", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "workflow-metric-lineage-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const before = ".github/workflows/public-release-example.yml",
    after = ".github/workflows/.release-example.yml";
  const source = (count) =>
    "on: workflow_call\njobs:\n" +
    Array.from(
      { length: count },
      (_, index) =>
        `  job_${index}:\n    runs-on: ubuntu-latest\n    steps: []\n`,
    ).join("");
  git("init", "-q");
  fs.mkdirSync(path.dirname(path.join(root, before)), { recursive: true });
  fs.writeFileSync(path.join(root, before), source(9));
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  const revision = git("rev-parse", "HEAD").trim();
  git("mv", before, after);
  const baseline = { [before]: analyzeWorkflow(before, source(9)) };
  const projected = projectRenamedMetrics({
    root,
    revision,
    metrics: baseline,
    currentPaths: new Set([after]),
  });
  const policy = {
    workflowBudgets: {
      maxLines: 600,
      maxJobs: 8,
      maxSteps: 50,
      maxStepsPerJob: 20,
      maxDecisions: 25,
    },
  };
  const evaluate = (jobs) =>
    evaluateWorkflowBudgets({
      current: { workflows: { [after]: analyzeWorkflow(after, source(jobs)) } },
      baselineFiles: projected.metrics,
      policy,
    });
  assert.equal(projected.renames.length, 1);
  assert.deepEqual(evaluate(9), []);
  assert(
    evaluate(10).some((issue) => issue.includes("jobs is 10; budget is 9")),
  );
  assert.equal(Object.hasOwn(baseline, after), false);
});

test("workflow measurement uses stable declared identity without requiring Git ancestry", () => {
  const source = ".github/workflows/public-release-example.yml";
  const target = ".github/workflows/.release-example.yml";
  const baseline = { [source]: { file: source, lines: 2051, jobs: 14 } };
  const request = {
    metrics: baseline,
    before: [{ id: "release-example", path: source }],
    after: [{ id: "release-example", path: target }],
    currentPaths: new Set([target]),
  };
  const projection = projectWorkflowMetrics(request);
  assert.deepEqual(projection.renames, [
    { id: "release-example", source, target },
  ]);
  assert.equal(projection.metrics[target].lines, 2051);
  assert.equal(baseline[target], undefined);
  const policy = {
    workflowBudgets: {
      maxLines: 600,
      maxJobs: 8,
      maxSteps: 100,
      maxStepsPerJob: 50,
      maxDecisions: 100,
    },
  };
  const evaluate = (jobs) =>
    evaluateWorkflowBudgets({
      policy,
      baselineFiles: projection.metrics,
      current: {
        workflows: {
          [target]: {
            lines: 728,
            jobs,
            steps: 1,
            maxStepsPerJob: 1,
            decisions: 0,
          },
        },
      },
    });
  assert.deepEqual(evaluate(14), []);
  assert(
    evaluate(15).some((issue) => issue.includes("jobs is 15; budget is 14")),
  );
  assert.deepEqual(
    projectWorkflowMetrics({
      ...request,
      currentPaths: new Set([source, target]),
    }).renames,
    [],
  );
  assert.deepEqual(
    projectWorkflowMetrics({
      ...request,
      after: [{ id: "unrelated", path: target }],
    }).renames,
    [],
  );
  assert.throws(
    () =>
      projectWorkflowMetrics({
        ...request,
        after: [...request.after, { id: "release-example", path: "copy.yml" }],
      }),
    /unique/,
  );
  assert.throws(
    () =>
      projectWorkflowMetrics({
        ...request,
        after: [...request.after, { id: "copy", path: target }],
      }),
    /unique/,
  );
});
