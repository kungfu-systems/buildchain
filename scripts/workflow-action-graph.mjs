import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import ts from "typescript";

export const repositoryRoot = path.resolve(import.meta.dirname, "..");
export function localActionDirectory(uses) {
  if (typeof uses !== "string") return null;
  const match =
    /^(?:\$\/|\.\/(?:\.buildchain\/[a-z0-9][a-z0-9-]*\/)?)((?:actions)\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+)$/u.exec(
      uses,
    );
  return match?.[1] || null;
}
export function readWorkflow(relative, root = repositoryRoot) {
  return YAML.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}
function requiredPhase(condition = "") {
  const source = condition.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/gu, "");
  const clauses = [];
  let depth = 0,
    quote = false,
    start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "'") {
      if (quote && source[index + 1] === "'") index += 1;
      else quote = !quote;
    }
    if (quote) continue;
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") depth -= 1;
    if (!depth && source.slice(index, index + 2) === "||") return undefined;
    if (!depth && source.slice(index, index + 2) === "&&") {
      clauses.push(source.slice(start, index).trim());
      start = index + 2;
      index += 1;
    }
  }
  clauses.push(source.slice(start).trim());
  for (const clause of clauses) {
    const match = /^inputs\.phase == '([a-z-]+)'$/u.exec(clause);
    if (match) return match[1];
  }
  return undefined;
}
function excludedPhase(step, inputs) {
  const phase = requiredPhase(step.if);
  return (
    phase &&
    typeof inputs.phase === "string" &&
    !inputs.phase.includes("${{") &&
    inputs.phase !== phase
  );
}
export function inspectWorkflowJob(relative, jobId, root = repositoryRoot) {
  const workflow = readWorkflow(relative, root);
  const job = workflow.jobs[jobId];
  assert.ok(job, `Unknown workflow job: ${relative}#${jobId}`);
  const actions = new Map();
  const modules = new Map();
  const steps = [];
  function sourceModule(file) {
    file = path.posix.normalize(file);
    assert.ok(
      !path.posix.isAbsolute(file) && !file.startsWith("../"),
      `Module escapes repository: ${file}`,
    );
    if (modules.has(file)) return;
    const text = fs.readFileSync(path.join(root, file), "utf8");
    modules.set(file, text);
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      let value;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        value = node.moduleSpecifier;
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(source) === "require")
      )
        value = node.arguments[0];
      if (value && ts.isStringLiteral(value) && value.text.startsWith(".")) {
        const dependency = path.posix.normalize(
          path.posix.join(path.posix.dirname(file), value.text),
        );
        if (/\.[cm]?js$/u.test(dependency)) sourceModule(dependency);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  function walk(step, ancestry = [], inputs = {}) {
    // Resolve only literal phase dispatch. Other conditions remain possible;
    // this graph must not pretend to evaluate GitHub's expression engine.
    if (excludedPhase(step, inputs)) return;
    steps.push({ ...step, ancestry });
    const directory = localActionDirectory(step.uses);
    if (!directory) return;
    assert.ok(
      !ancestry.includes(directory),
      `Composite action cycle: ${[...ancestry, directory].join(" -> ")}`,
    );
    const action = readWorkflow(`${directory}/action.yml`, root);
    actions.set(directory, action);
    const childInputs = Object.fromEntries(
      Object.entries(step.with || {}).map(([key, value]) => [
        key,
        value === "${{ inputs.phase }}" ? inputs.phase : value,
      ]),
    );
    if (action.runs.using === "composite") {
      for (const child of action.runs.steps) {
        if (excludedPhase(child, childInputs)) continue;
        assert.ok(
          child.uses && !child.run && !child.shell && !child.with?.script,
          `${directory}: composite must invoke actions, not executable scripts`,
        );
        walk(child, [...ancestry, directory], childInputs);
      }
    } else if (/^node\d+$/u.test(action.runs.using)) {
      // The reviewed source entry is checked against its generated distribution
      // by check-action-bundles; never infer authority from minified text.
      sourceModule(`${directory}/index.js`);
      if (action.runs.post)
        sourceModule(`${directory}/${path.posix.basename(action.runs.post)}`);
    } else throw new Error(`Unsupported owned action kind: ${directory}`);
  }
  for (const step of job.steps || []) walk(step);
  return { workflow, job, actions, modules, steps };
}
