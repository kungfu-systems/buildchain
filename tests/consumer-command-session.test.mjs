import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  consumerCommandSession,
  parseEnvironmentCommands,
} from "../packages/core/runtime/consumer-shell.js";
import { runAction } from "../packages/core/runtime/action-host.js";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-command-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, GITHUB_SHA: "a".repeat(40) };
  for (const key of [
    "GITHUB_ENV",
    "GITHUB_PATH",
    "GITHUB_OUTPUT",
    "GITHUB_STEP_SUMMARY",
  ]) {
    env[key] = path.join(root, key);
    fs.writeFileSync(env[key], "");
  }
  return { root, env };
}
test("consumer phases inherit environment and path updates while their outputs remain isolated", async (t) => {
  const { root, env } = workspace(t),
    session = consumerCommandSession(env),
    directories = [];
  await session.run(
    { script: "build", cwd: root, env: { STATIC: "build" } },
    (_, args, { env: phase }) => {
      directories.push(path.dirname(phase.GITHUB_ENV));
      assert.notEqual(phase.GITHUB_OUTPUT, env.GITHUB_OUTPUT);
      fs.writeFileSync(
        phase.GITHUB_ENV,
        "VALUE<<END\nline one\nline two\nEND\nSTATIC=consumer\nGITHUB_SHA=forged\n",
      );
      fs.writeFileSync(phase.GITHUB_PATH, `${path.join(root, "bin")}\n`);
      fs.writeFileSync(phase.GITHUB_OUTPUT, "web-surface-channel=production\n");
      fs.writeFileSync(phase.GITHUB_STEP_SUMMARY, "build summary\n");
    },
  );
  await session.run(
    { script: "verify", cwd: root, env: { STATIC: "verify" } },
    (_, args, { env: phase }) => {
      directories.push(path.dirname(phase.GITHUB_ENV));
      assert.equal(phase.VALUE, "line one\nline two");
      assert.equal(phase.STATIC, "verify");
      assert.equal(phase.GITHUB_SHA, env.GITHUB_SHA);
      assert.ok(phase.PATH.startsWith(path.join(root, "bin")));
      assert.equal(fs.readFileSync(phase.GITHUB_ENV, "utf8"), "");
      fs.writeFileSync(phase.GITHUB_STEP_SUMMARY, "verify summary\n");
    },
  );
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, "utf8"), "");
  assert.equal(
    fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"),
    "build summary\nverify summary\n",
  );
  assert.equal(
    parseEnvironmentCommands(fs.readFileSync(env.GITHUB_ENV, "utf8")).VALUE,
    "line one\nline two",
  );
  assert.ok(directories.every((directory) => !fs.existsSync(directory)));
});
test("malformed command files stop subsequent phases without masking the consumer exit status", async (t) => {
  const { root, env } = workspace(t),
    session = consumerCommandSession(env);
  await assert.rejects(
    session.run({ script: "build", cwd: root }, (_, args, { env: phase }) => {
      fs.writeFileSync(phase.GITHUB_ENV, "VALUE<<END\nmissing terminator");
      throw Object.assign(new Error("consumer failed"), { status: 37 });
    }),
    (error) => error.status === 37 && error.errors.length === 2,
  );
});
test("runner environment framing preserves Windows multiline bytes and rejects forbidden Node options", async (t) => {
  assert.deepEqual(
    parseEnvironmentCommands(
      "VALUE<<END\r\nfirst\r\nsecond\r\nEND\r\n",
      "win32",
    ),
    { VALUE: "first\r\nsecond" },
  );
  assert.deepEqual(
    parseEnvironmentCommands("VALUE=literal=tail\nEMPTY<<END\nEND\n"),
    { VALUE: "literal=tail", EMPTY: "" },
  );
  const { root, env } = workspace(t),
    session = consumerCommandSession(env);
  await assert.rejects(
    session.run({ script: "build", cwd: root }, (_, args, { env: phase }) =>
      fs.writeFileSync(phase.GITHUB_ENV, "NODE_OPTIONS=--inspect\n"),
    ),
    /cannot set NODE_OPTIONS/,
  );
});
test("action host preserves the failing domain process status after reporting failure", async () => {
  const host = {},
    messages = [];
  await runAction(
    () => {
      throw Object.assign(new Error("failed transaction"), { status: 37 });
    },
    { setFailed: (value) => messages.push(value) },
    {},
    host,
  );
  assert.equal(host.exitCode, 37);
  assert.deepEqual(messages, ["failed transaction"]);
});
