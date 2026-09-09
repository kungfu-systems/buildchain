import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
test("runtime preparation exposes an executable path that survives consumer PATH changes", (t) => {
  const action = YAML.parse(
    fs.readFileSync(
      new URL("../actions/runtime/prepare/action.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(action.runs.steps[0].with["node-version"], "24");
  assert.equal(
    action.outputs["node-path"].value,
    "${{ steps.node.outputs.path }}",
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-path-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, "output.txt");
  const step = action.runs.steps.find((s) => s.id === "node");
  const result = spawnSync("bash", ["-c", step.run], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const selected = fs.readFileSync(output, "utf8").trim().slice("path=".length);
  assert.equal(selected, process.execPath.replaceAll("\\", "/"));
  const execution = spawnSync(selected, ["-p", "process.version"], {
    encoding: "utf8",
    env: { ...process.env, PATH: directory },
  });
  assert.equal(execution.status, 0, execution.error?.message);
  assert.equal(execution.stdout.trim(), process.version);
});

test("Corepack resolves the package manager inside the exact runtime checkout", (t) => {
  const action = YAML.parse(
    fs.readFileSync(
      new URL("../actions/runtime/prepare/action.yml", import.meta.url),
      "utf8",
    ),
  );
  const step = action.runs.steps.find(
    (s) => s.name === "Install locked runtime dependencies",
  );
  assert.equal(step["working-directory"], "${{ inputs.directory }}");
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "runtime-package-manager-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime"),
    bin = path.join(root, "bin"),
    log = path.join(root, "corepack-cwd");
  fs.mkdirSync(runtime);
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(runtime, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11.7.0" }),
  );
  fs.writeFileSync(
    path.join(bin, "corepack"),
    '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.COREPACK_CWD_LOG, `${process.cwd()}\\n`);\n',
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", step.run], {
    cwd: runtime,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      COREPACK_CWD_LOG: log,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
    fs.realpathSync(runtime),
    fs.realpathSync(runtime),
  ]);
});
