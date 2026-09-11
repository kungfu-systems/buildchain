import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const entry = path.join(
  repositoryRoot,
  "packages/core/build/source/lifecycle.js",
);
function fixture(t, kind = "report", extra = "") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paper-policy-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".buildchain"));
  fs.writeFileSync(
    path.join(cwd, ".buildchain/buildchain.toml"),
    `schema = 1
[project]
type = 'publication-artifact'
name = "publication-report"
[publication]
${kind ? `kind = "${kind}"` : ""}
title = "Report"
version = "2026.8.0"
primary_artifact = "report.pdf"
${extra}
`,
  );
  fs.symlinkSync(repositoryRoot, path.join(cwd, ".buildchain/runtime"), "dir");
  return cwd;
}
function run(cwd) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { admitSourcePaper } from ${JSON.stringify(new URL("file://" + entry).href)}; console.log(JSON.stringify(admitSourcePaper({ cwd: process.cwd(), runtimeRoot: ${JSON.stringify(repositoryRoot)}, runtimeRef: "v4" })));`,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        BUILDCHAIN_CHECK_REQUEST_JSON: JSON.stringify({
          "working-directory": ".",
        }),
        BUILDCHAIN_RUNTIME_REF: "v4",
      },
    },
  );
}
for (const kind of ["report", "specification", "article", "dataset-note"]) {
  test(`${kind} lifecycle does not require Paper provisioning`, (t) => {
    const result = run(fixture(t, kind));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"applicable":false/);
  });
}
for (const kind of ["paper", ""]) {
  test(`Paper policy remains required for ${kind || "default kind"}`, (t) => {
    const result = run(fixture(t, kind));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout + result.stderr, /provisioning\.authority/);
    assert.doesNotMatch(result.stdout, /"applicable":false/);
  });
}
test("npm Paper package cannot skip governance by changing publication kind", (t) => {
  const result = run(
    fixture(
      t,
      "report",
      '[publish]\nkind = "npm-paper-package"\npackage = "@example/report"',
    ),
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /provisioning\.authority/);
});
test("existing Paper directory keeps policy active after config removal", (t) => {
  const cwd = fixture(t);
  fs.mkdirSync(path.join(cwd, ".buildchain/paper"));
  fs.unlinkSync(path.join(cwd, ".buildchain/buildchain.toml"));
  const result = run(cwd);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /"applicable":false/);
});
test("malformed configuration fails closed", (t) => {
  const cwd = fixture(t);
  fs.writeFileSync(path.join(cwd, ".buildchain/buildchain.toml"), "[project");
  const result = run(cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /parse failed/);
});
test("the public check reaches the required owned Paper policy node", () => {
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, ".github/workflows/public-build-check.yml"),
    "utf8",
  );
  const action = fs.readFileSync(
    path.join(
      repositoryRoot,
      "actions/build/source/check-lifecycle/action.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /actions\/build\/source\/qualify/);
  const controller = fs.readFileSync(
    path.join(repositoryRoot, "actions/build/source/qualify/action.yml"),
    "utf8",
  );
  assert.match(controller, /actions\/build\/source\/check-lifecycle/);
  assert.match(action, /actions\/build\/source\/run-check/);
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, ".github/workflows/check.yml")),
    false,
  );
});
