#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  dependencyCycles,
  relativeImports,
} from "./check-internal-architecture.mjs";

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const GENERATED_PATTERN = /^actions\/[^/]+\/dist\/.*\.js$/u;

function gitText(root, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: root,
    encoding,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function trackedFiles(root, revision = "") {
  const args = revision
    ? ["ls-tree", "-r", "-z", "--name-only", revision]
    : ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  return gitText(root, args).split("\0").filter(Boolean).sort();
}

function readTrackedFile(root, file, revision = "") {
  return revision
    ? gitText(root, ["show", `${revision}:${file}`])
    : fs.readFileSync(path.join(root, file), "utf8");
}

function lineCount(source) {
  if (!source) return 0;
  const lines = source.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function isTestFile(file) {
  return file.startsWith("tests/") || /(?:^|\/)test(?:s)?\//u.test(file);
}

function isGeneratedFile(file) {
  return GENERATED_PATTERN.test(file);
}

function isHandMaintainedSource(file) {
  return (
    JS_EXTENSIONS.has(path.extname(file)) &&
    !isTestFile(file) &&
    !isGeneratedFile(file)
  );
}

function isFunctionNode(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function propertyName(node) {
  if (!node) return "";
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return node.getText();
}

function functionName(node, sourceFile) {
  if (node.name) return propertyName(node.name);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) return propertyName(parent.name);
  if (ts.isPropertyAssignment(parent)) return propertyName(parent.name);
  if (ts.isExportAssignment(parent)) return "default";
  const start =
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;
  return `<anonymous@${start}>`;
}

function isLogicalDecision(node) {
  return (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  );
}

function isDecision(node) {
  return (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isConditionalExpression(node) ||
    ts.isCaseClause(node) ||
    isLogicalDecision(node)
  );
}

function functionComplexity(node) {
  let complexity = 1;
  const visit = (child) => {
    if (child !== node && isFunctionNode(child)) return;
    if (child !== node && isDecision(child)) complexity += 1;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return complexity;
}

function analyzeJavaScript(file, source) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.JS,
  );
  const functions = [];
  const visit = (node) => {
    if (isFunctionNode(node)) {
      const start =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1;
      const end =
        sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      functions.push({
        name: functionName(node, sourceFile),
        start,
        end,
        lines: end - start + 1,
        complexity: functionComplexity(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  functions.sort(
    (left, right) =>
      left.start - right.start || left.name.localeCompare(right.name),
  );
  return {
    lines: lineCount(source),
    complexity: functions.reduce((total, entry) => total + entry.complexity, 0),
    functions,
  };
}

function countRegistryEntries(root, file, field, revision = "") {
  const value = JSON.parse(readTrackedFile(root, file, revision));
  return Array.isArray(value[field]) ? value[field].length : 0;
}

function architectureSummary(root, revision = "") {
  const index = JSON.parse(
    readTrackedFile(root, "architecture/internal-capabilities.json", revision),
  );
  const implementationPaths = new Set(
    index.capabilities.flatMap((entry) => entry.implementation || []),
  );
  const repositorySources = trackedFiles(root, revision).filter(
    isHandMaintainedSource,
  );
  const repositorySourceSet = new Set(repositorySources);
  const graph = new Map(repositorySources.map((file) => [file, new Set()]));
  for (const file of repositorySources) {
    if (!JS_EXTENSIONS.has(path.extname(file))) continue;
    for (const specifier of relativeImports(
      readTrackedFile(root, file, revision),
    )) {
      const base = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), specifier),
      );
      const target = [
        base,
        `${base}.js`,
        `${base}.mjs`,
        `${base}.cjs`,
        `${base}/index.js`,
        `${base}/index.mjs`,
      ].find((candidate) => repositorySourceSet.has(candidate));
      if (target) graph.get(file).add(target);
    }
  }
  const exclusions = new Set(
    (index.ownershipExclusions || []).map((entry) => entry.path),
  );
  const ownedSources = repositorySources.filter((file) =>
    index.ownershipRules?.some((rule) =>
      (rule.paths || []).some(
        (prefix) => file === prefix || file.startsWith(`${prefix}/`),
      ),
    ),
  ).length;
  return {
    capabilities: index.capabilities.length,
    implementationMappings: index.capabilities.reduce(
      (total, entry) => total + (entry.implementation || []).length,
      0,
    ),
    testMappings: index.capabilities.reduce(
      (total, entry) => total + (entry.tests || []).length,
      0,
    ),
    dependencyRules: index.dependencyRules.length,
    repositorySources: repositorySources.length,
    ownedSources,
    excludedSources: repositorySources.filter((file) => exclusions.has(file))
      .length,
    dependencyEdges: [...graph.values()].reduce(
      (total, targets) => total + targets.size,
      0,
    ),
    dependencyCycles: dependencyCycles(graph).length,
  };
}

function selectedFunction(files, file, name) {
  const entry = files[file];
  const matches =
    entry?.functions.filter((candidate) => candidate.name === name) || [];
  if (matches.length !== 1) {
    throw new Error(
      `${file} must contain exactly one ${name} function; found ${matches.length}`,
    );
  }
  return matches[0];
}

function collectMaintainabilityMetrics({
  root = process.cwd(),
  revision = "",
} = {}) {
  const files = trackedFiles(root, revision);
  const sourceFiles = files.filter(isHandMaintainedSource);
  const testFiles = files.filter(
    (file) => JS_EXTENSIONS.has(path.extname(file)) && isTestFile(file),
  );
  const workflowFiles = files.filter((file) =>
    /^\.github\/workflows\/.*\.ya?ml$/u.test(file),
  );
  const generatedFiles = files.filter(isGeneratedFile);
  const documentationFiles = files.filter((file) => file.endsWith(".md"));
  const sourceMetrics = Object.fromEntries(
    sourceFiles.map((file) => {
      const source = readTrackedFile(root, file, revision);
      return [file, analyzeJavaScript(file, source)];
    }),
  );
  const sumLines = (entries) =>
    entries.reduce(
      (total, file) => total + lineCount(readTrackedFile(root, file, revision)),
      0,
    );
  const generatedBytes = generatedFiles.reduce(
    (total, file) =>
      total + Buffer.byteLength(readTrackedFile(root, file, revision)),
    0,
  );
  const workflowRegistry = JSON.parse(
    readTrackedFile(root, "dist/site/workflow-registry.json", revision),
  );
  const reverseAudit = JSON.parse(
    readTrackedFile(root, "dist/site/public-surface-audit.json", revision),
  );
  const head = revision || gitText(root, ["rev-parse", "HEAD"]).trim();
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-maintainability-metrics",
    revision: head,
    repository: {
      trackedFiles: files.length,
      handMaintainedSourceFiles: sourceFiles.length,
      handMaintainedSourceLines: Object.values(sourceMetrics).reduce(
        (total, entry) => total + entry.lines,
        0,
      ),
      testFiles: testFiles.length,
      testLines: sumLines(testFiles),
      workflowFiles: workflowFiles.length,
      workflowLines: sumLines(workflowFiles),
      documentationFiles: documentationFiles.length,
      documentationLines: sumLines(documentationFiles),
      generatedFiles: generatedFiles.length,
      generatedBytes,
    },
    publicSurface: {
      cliCommands: countRegistryEntries(
        root,
        "dist/site/cli-registry.json",
        "commands",
        revision,
      ),
      nodeApiExports: countRegistryEntries(
        root,
        "dist/site/node-api-registry.json",
        "exports",
        revision,
      ),
      workflows: Array.isArray(workflowRegistry.workflows)
        ? workflowRegistry.workflows.length
        : 0,
      actions: Array.isArray(workflowRegistry.actions)
        ? workflowRegistry.actions.length
        : 0,
      reverseAuditFailures: Number(reverseAudit.summary?.failureCount || 0),
    },
    architecture: architectureSummary(root, revision),
    hotspots: {
      promoteBuildchainRefs: {
        file: "actions/promote-buildchain-ref/lib.js",
        ...selectedFunction(
          sourceMetrics,
          "actions/promote-buildchain-ref/lib.js",
          "promoteBuildchainRefs",
        ),
      },
      createReleaseCheckReport: {
        file: "packages/core/release-passport.js",
        ...selectedFunction(
          sourceMetrics,
          "packages/core/release-passport.js",
          "createReleaseCheckReport",
        ),
      },
    },
    files: sourceMetrics,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  console.log(JSON.stringify(collectMaintainabilityMetrics(), null, 2));
}

export {
  analyzeJavaScript,
  collectMaintainabilityMetrics,
  isHandMaintainedSource,
  lineCount,
};
