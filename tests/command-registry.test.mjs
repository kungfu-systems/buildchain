import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BUILDCHAIN_COMMAND_HANDLERS } from "../packages/core/workflow/cli/main.mjs";
import {
  BUILDCHAIN_COMMAND_REGISTRY,
  dispatchRegisteredCommand,
  resolveBuildchainCommand,
} from "../packages/core/contracts/command-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("CLI runtime binds bounded command handlers without a monolithic dispatcher", () => {
  const source = fs.readFileSync(
    path.join(root, "bin", "buildchain.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /runRegisteredCommand/u);
  assert.deepEqual(
    Object.keys(BUILDCHAIN_COMMAND_HANDLERS).sort(),
    BUILDCHAIN_COMMAND_REGISTRY.map((entry) => entry.id).sort(),
  );
  assert.ok(
    Object.values(BUILDCHAIN_COMMAND_HANDLERS).every(
      (handler) => typeof handler === "function",
    ),
  );
  assert.ok(source.trim().split("\n").length <= 12);
});

test("CLI command registry owns canonical names, aliases, help, and runtime dispatch", async () => {
  const names = BUILDCHAIN_COMMAND_REGISTRY.flatMap((entry) => [
    entry.id,
    ...entry.aliases,
  ]);
  assert.equal(new Set(names).size, names.length);
  const help = execFileSync(
    process.execPath,
    ["bin/buildchain.mjs", "--help"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  for (const entry of BUILDCHAIN_COMMAND_REGISTRY) {
    assert.match(help, new RegExp(`\\b${entry.id.replaceAll("-", "\\-")}\\b`));
  }

  const calls = [];
  const handlers = Object.fromEntries(
    BUILDCHAIN_COMMAND_REGISTRY.map((entry) => [
      entry.id,
      async (args, resolution) => calls.push({ args, resolution }),
    ]),
  );
  await dispatchRegisteredCommand({
    command: "publication",
    args: ["manifest"],
    handlers,
  });
  assert.equal(calls[0].resolution.registration.id, "publication-artifact");
  assert.deepEqual(calls[0].args, ["manifest"]);
  assert.equal(resolveBuildchainCommand("--version").id, "version");
  await assert.rejects(
    dispatchRegisteredCommand({ command: "not-a-command", handlers }),
    /unsupported buildchain command/,
  );
});
