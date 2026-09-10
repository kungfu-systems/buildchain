import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = "templates/bootstrap-recovery";
const installed = ".buildchain/bootstrap-recovery";
const shell = "./.buildchain/workflow-shell/";
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const digest = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const files = new Map();
// Traverse action composition, shipping committed JS bundles for trusted shell
// actions. Candidate-owned actions remain supplied by the reviewed checkout.
const pending = ["actions/workflow/recovery/admit", "actions/workflow/recovery/execute", "actions/workflow/recovery/settle"];
const visited = new Set();
while (pending.length) {
  const directory = pending.pop();
  if (visited.has(directory)) continue;
  visited.add(directory);
  const file = `${directory}/action.yml`, action = YAML.parse(read(file));
  if (action.runs.using === "composite") {
    for (const step of action.runs.steps) {
      assert.ok(step.uses && !step.run && !step.shell, `Recovery action must only compose actions: ${file}`);
      if (step.uses.startsWith(shell)) {
        pending.push(step.uses.slice(shell.length));
        step.uses = step.uses.replace(shell, `${shell}${installed}/`);
      } else if (step.uses.startsWith("./")) {
        assert.ok(step.uses.startsWith("./.buildchain/candidate/actions/"), `Unexpected recovery authority: ${step.uses}`);
      }
    }
  } else {
    assert.equal(action.runs.using, "node24", `Unsupported recovery action runtime: ${file}`);
    for (const entry of [action.runs.main, action.runs.pre, action.runs.post].filter(Boolean)) {
      assert.ok(/^dist\/[a-zA-Z0-9._-]+\.js$/.test(entry), `Recovery action must ship bundled entries: ${file}`);
      files.set(`${directory}/${entry}`, read(`${directory}/${entry}`));
    }
  }
  files.set(file, YAML.stringify(action, { lineWidth: 0, aliasDuplicateObjects: false }));
}
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
if (!check) {
  const previousPath = path.join(root, bundle, "manifest.json");
  const previous = fs.existsSync(previousPath) ? JSON.parse(fs.readFileSync(previousPath, "utf8")) : { files: [] };
  for (const { path: file } of previous.files) {
    assert.ok(!path.isAbsolute(file) && !file.split("/").includes(".."), `Unsafe generated recovery path: ${file}`);
    const target = `${bundle}/${file}`;
    if (!expected.has(target)) fs.rmSync(path.join(root, target), { force: true });
  }
}
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
