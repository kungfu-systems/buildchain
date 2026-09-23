import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderCompatibilityWorkflow } from "../packages/core/consumer/compatibility-workflows.js";

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
    `name: lint fixture\non: push\njobs:\n  check:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: ./.buildchain/workflow-shell/${action}\n        with:\n          ${input}: \${{ job.workflow_sha }}\n`;
  write(".github/workflows/fixture.yml", workflow("fresh-input"));
  write(".github/actionlint.yaml", 'paths:\n  .github/workflows/fixture.yml:\n    ignore:\n      - property "workflow_sha" is not defined in object type\n');
  const command = path.resolve(
    import.meta.dirname,
    "../scripts/check-dev-delivery-actions.mjs",
  );
  const env = { ...process.env };
  fs.mkdirSync(path.join(root, "temporary"));
  const temporaryAlias = path.join(root, "temporary-alias");
  fs.symlinkSync(path.join(root, "temporary"), temporaryAlias, "junction");
  Object.assign(env, { TMPDIR: temporaryAlias, TMP: temporaryAlias, TEMP: temporaryAlias });
  if (process.platform !== "win32") {
    write(
      "tools/actionlint",
      '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.BUILDCHAIN_TEST_OLD_ACTIONLINT_RECORD, process.argv[2] + "\\n");\nconsole.log("1.0.0");\nprocess.exit(process.argv[2] === "-version" ? 0 : 91);\n',
    );
    fs.chmodSync(path.join(root, "tools/actionlint"), 0o755);
    env.PATH = path.join(root, "tools") + path.delimiter + env.PATH;
    env.BUILDCHAIN_TEST_OLD_ACTIONLINT_RECORD = path.join(
      root,
      "old-tool-calls.txt",
    );
  }
  const lint = () =>
    spawnSync(process.execPath, [command], {
      cwd: root,
      encoding: "utf8",
      env,
    });
  const accepted = lint();
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  if (process.platform !== "win32")
    assert.equal(
      fs.readFileSync(env.BUILDCHAIN_TEST_OLD_ACTIONLINT_RECORD, "utf8"),
      "-version\n",
    );
  const retained = {
    path: ".github/workflows/retained.yml",
    target: ".github/workflows/fixture.yml",
    interfaceSource: "on:\n  workflow_call:\n",
  };
  const canonical = workflow("fresh-input").replace("on: push", "on:\n  workflow_call:");
  write(retained.target, canonical);
  write("architecture/consumer-upgrade.json", JSON.stringify({
    schema: "buildchain.consumer-upgrade/v1", source: { sha: "a".repeat(40) }, entries: [retained],
  }));
  write(retained.path, renderCompatibilityWorkflow(retained, canonical));
  const compatible = lint();
  assert.equal(compatible.status, 0, compatible.stdout + compatible.stderr);
  write(retained.path, renderCompatibilityWorkflow(retained, canonical).replace("fresh-input", "undeclared-input"));
  const drift = lint();
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /generated consumer compatibility workflow drift/);
  fs.unlinkSync(path.join(root, retained.path));
  fs.unlinkSync(path.join(root, "architecture/consumer-upgrade.json"));
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
