import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = "templates/bootstrap-recovery";
const installed = ".buildchain/bootstrap-recovery";
const shell = "./.buildchain/workflow-shell/";
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const digest = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const files = new Map();
const pending = ["packages/core/workflow/nodes/bootstrap-recovery.mjs"];
while (pending.length) {
  const file = pending.pop();
  if (files.has(file)) continue;
  const text = read(file);
  files.set(file, text);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith("node:")) return;
      assert.ok(specifier.startsWith("."), `Recovery must start without installed dependencies: ${file}: ${specifier}`);
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      assert.ok(dependency.startsWith("packages/core/"), `Recovery dependency escapes its runtime layer: ${dependency}`);
      pending.push(dependency);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      throw new Error(`Recovery distribution requires statically closed imports: ${file}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const actionNames = ["bootstrap-recovery-admit", "bootstrap-recovery-execute", "bootstrap-recovery-settle"];
for (const name of actionNames) {
  const file = `actions/workflow/${name}/action.yml`;
  files.set(file, read(file).replaceAll(`${shell}actions/runtime/prepare`, `${shell}${installed}/actions/runtime/prepare`));
}
files.set("actions/runtime/prepare/action.yml", read("actions/runtime/prepare/action.yml"));
files.set("package.json", json({
  name: "buildchain-consumer-recovery",
  private: true,
  type: "module",
  version: JSON.parse(read("package.json")).version,
  engines: { node: ">=24" },
}));
const workflow = YAML.parse(read(".github/workflows/public-ops-bootstrap-recovery.yml"));
for (const job of Object.values(workflow.jobs)) {
  for (const step of job.steps) {
    if (step.uses?.startsWith(`${shell}actions/workflow/`))
      step.uses = step.uses.replace(shell, `${shell}${installed}/`);
  }
}
const workflowText = YAML.stringify(workflow, { lineWidth: 0, aliasDuplicateObjects: false });
const manifest = {
  schema: "buildchain.bootstrap-recovery-distribution/v1",
  installDirectory: installed,
  workflowDestination: ".github/workflows/buildchain-bootstrap-recovery.yml",
  workflowRoot: digest(workflowText),
  files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, text]) => ({ path: file, root: digest(text) })),
};
files.set("manifest.json", json(manifest));
const expected = new Map([...files].map(([file, text]) => [`${bundle}/${file}`, text]));
expected.set("templates/universal-buildchain-bootstrap-recovery.yml", workflowText);
const check = process.argv.includes("--check");
for (const [file, text] of expected) {
  if (check) assert.equal(read(file), text, `Recovery distribution drift: ${file}`);
  else {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}
function discover(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    assert.equal(entry.isSymbolicLink(), false, `Recovery distribution cannot contain symlinks: ${entry.name}`);
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? discover(file) : [file];
  });
}
assert.deepEqual(discover(bundle).sort(), [...expected.keys()].filter((file) => file.startsWith(`${bundle}/`)).sort(), "Recovery distribution contains unowned files");
console.log(json({ ok: true, files: files.size, mode: check ? "check" : "generate" }).trim());
