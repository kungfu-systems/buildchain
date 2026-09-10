#!/usr/bin/env node
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export function checkSourceBindings({ root = process.cwd(), files } = {}) {
  const sources =
    files ||
    execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(
        (file) => file.startsWith("packages/core/") && /\.(m?js)$/.test(file),
      );
  const resolved = new Set(sources.map((file) => path.resolve(root, file)));
  const program = ts.createProgram([...resolved], {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    types: ["node"],
  });
  const issues = program
    .getSemanticDiagnostics()
    .filter(
      (issue) =>
        [2304, 2305, 2459, 2552].includes(issue.code) &&
        issue.file &&
        resolved.has(path.resolve(issue.file.fileName)),
    )
    .map((issue) => ({
      file: path.relative(root, issue.file.fileName),
      line: issue.file.getLineAndCharacterOfPosition(issue.start).line + 1,
      message: ts.flattenDiagnosticMessageText(issue.messageText, " "),
    }));
  return { files: resolved.size, issues };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const report = checkSourceBindings();
  console.log(JSON.stringify(report));
  if (report.issues.length) process.exitCode = 1;
}
