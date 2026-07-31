import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  BUILDCHAIN_COMMAND_REGISTRY,
  dispatchRegisteredCommand,
  resolveBuildchainCommand,
} from "../bin/internal/command-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");

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
