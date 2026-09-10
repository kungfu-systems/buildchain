import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("workflow lint binds source action inputs despite a foreign executing runtime and preserves failures", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-lint-source-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  write(".git/lint-project-marker", "isolated actionlint fixture\n");
  write("architecture/dev-delivery-orchestration.json", '{"nodes":[]}\n');
  const action = "actions/workflow/fixture/execute";
  const metadata = (input) =>
    `name: fixture\ndescription: Source input fixture\ninputs:\n  ${input}:\n    description: Explicit value\nruns:\n  using: node24\n  main: index.js\n`;
  write(`${action}/action.yml`, metadata("fresh-input"));
  write(`${action}/index.js`, "// Static metadata fixture.\n");
  const foreign = `.buildchain/workflow-shell/${action}/action.yml`;
  write(foreign, metadata("old-input"));
  write(
    `.buildchain/workflow-shell/${action}/index.js`,
    "// Foreign runtime fixture.\n",
  );
  const workflow = (input) =>
    `name: lint fixture\non: push\njobs:\n  check:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: ./.buildchain/workflow-shell/${action}\n        with:\n          ${input}: value\n`;
  write(".github/workflows/fixture.yml", workflow("fresh-input"));
  const command = path.resolve(
    import.meta.dirname,
    "../scripts/check-dev-delivery-actions.mjs",
  );
  const lint = () =>
    spawnSync(process.execPath, [command], { cwd: root, encoding: "utf8" });
  const accepted = lint();
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.equal(
    fs.readFileSync(path.join(root, foreign), "utf8"),
    metadata("old-input"),
  );
  write(".github/workflows/fixture.yml", workflow("undeclared-input"));
  const rejected = lint();
  assert.notEqual(rejected.status, 0);
  assert.match(
    rejected.stdout + rejected.stderr,
    /input "undeclared-input" is not defined/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, foreign), "utf8"),
    metadata("old-input"),
  );
});
