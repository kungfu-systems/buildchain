import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const { scripts } = JSON.parse(
  fs.readFileSync(path.join(root, "package.json")),
);
const files = fs
  .readdirSync(path.join(root, "tests"))
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => `tests/${name}`)
  .sort();

function commands(name, definitions = scripts, ancestors = []) {
  assert.ok(!ancestors.includes(name), `recursive check script: ${name}`);
  assert.equal(typeof definitions[name], "string", `missing script: ${name}`);
  return definitions[name].split(" && ").flatMap((command) => {
    const nested = /^pnpm run ([\w:-]+)$/u.exec(command);
    return nested
      ? commands(nested[1], definitions, [...ancestors, name])
      : [command];
  });
}

function nodeTests(plan) {
  return plan
    .filter((command) => command.startsWith("node --test "))
    .flatMap((command) => command.slice("node --test ".length).split(" "))
    .flatMap((entry) => (entry === "tests/*.test.mjs" ? files : [entry]))
    .sort();
}

function assertCompleteOnce(definitions) {
  assert.deepEqual(nodeTests(commands("check", definitions)), files);
}

test("full check runs every Node test file exactly once and retains all Rust gates", () => {
  assertCompleteOnce(scripts);
  const plan = commands("check");
  for (const crate of ["buildchain-v4-bridge", "buildchain-v4-contracts"]) {
    for (const gate of ["fmt", "clippy", "test"]) {
      assert.equal(
        plan.filter(
          (command) =>
            command.startsWith(`cargo ${gate} `) &&
            command.includes(`crates/${crate}/Cargo.toml`),
        ).length,
        1,
      );
    }
  }
  const focused = nodeTests(commands("check:v4-contracts"));
  assert.equal(focused.length, 22);
  assert.ok(focused.every((file) => files.includes(file)));
});

test("test-plan audit detects duplicate, missing and unknown test coverage", () => {
  for (const changed of [
    { ...scripts, check: `${scripts.check} && pnpm run check:v4-contracts` },
    { ...scripts, "test:unit": `node --test ${files.slice(1).join(" ")}` },
    { ...scripts, "test:unit": "node --test tests/missing.test.mjs" },
  ])
    assert.throws(() => assertCompleteOnce(changed), assert.AssertionError);
});

test("the full check shell chain preserves a failing child and stops later commands", (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-check-exit-"),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  // Exercise the same && operator used between every full-check stage.
  fs.writeFileSync(path.join(temporary, "fail.cjs"), "process.exit(23);\n");
  fs.writeFileSync(
    path.join(temporary, "later.cjs"),
    "require('fs').writeFileSync('ran', 'yes');\n",
  );
  const result = spawnSync("node fail.cjs && node later.cjs", {
    cwd: temporary,
    shell: true,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 23);
  assert.equal(fs.existsSync(path.join(temporary, "ran")), false);
});
