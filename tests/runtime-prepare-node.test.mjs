import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import { installLockedDependencies } from "../packages/core/runtime/locked-dependencies.js";

function fixture(t, packageManager = "pnpm@11.7.0") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-dependencies-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ packageManager }));
  fs.writeFileSync(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return directory;
}

test("runtime preparation preserves PATH-selected Node after the caller switches toolchain", t => {
  const action = YAML.parse(fs.readFileSync(new URL("../actions/runtime/environment/prepare/action.yml", import.meta.url), "utf8"));
  assert.equal(action.runs.steps[0].with["node-version"], "24");
  assert.equal(action.outputs["node-path"].value, "${{ steps.dependencies.outputs.node-path }}");
  const directory = fixture(t);
  const result = installLockedDependencies({ directory }, (program, args) => {
    if (program === "corepack") return "";
    const output = spawnSync(program, args, { encoding: "utf8" });
    assert.equal(output.status, 0, output.stderr);
    return output.stdout;
  });
  const execution = spawnSync(result.nodePath, ["-p", "process.version"], {
    encoding: "utf8", env: { ...process.env, PATH: directory },
  });
  assert.equal(execution.status, 0, execution.error?.message);
  assert.equal(execution.stdout.trim(), process.version);
});

test("every dependency operation uses the lockfile's checkout and respects install-script isolation", t => {
  const directory = fixture(t);
  for (const production of [true, false]) {
    const calls = [];
    installLockedDependencies({ directory, production }, (program, args, options) => {
      assert.equal(options.cwd, path.resolve(directory));
      calls.push([program, args]);
      return args.includes("process.execPath") ? "/selected/node" : "24.1.0";
    });
    assert.deepEqual(calls.slice(-2), [
      ["corepack", ["enable"]],
      ["corepack", ["pnpm", "install", "--frozen-lockfile", ...(production ? ["--prod"] : []), "--ignore-scripts"]],
    ]);
  }
});

test("floating manager, missing lock and wrong Node fail before any install", t => {
  const floating = fixture(t, "pnpm@latest");
  assert.throws(() => installLockedDependencies({ directory: floating }, () => assert.fail()), /exact pnpm/);
  const missing = fixture(t);
  fs.unlinkSync(path.join(missing, "pnpm-lock.yaml"));
  assert.throws(() => installLockedDependencies({ directory: missing }, () => assert.fail()), /ENOENT/);
  const directory = fixture(t);
  assert.throws(() => installLockedDependencies({ directory }, (program, args) => {
    assert.notEqual(program, "corepack");
    return args.includes("process.execPath") ? "/node22" : "22.0.0";
  }), /selected Node 24/);
});
