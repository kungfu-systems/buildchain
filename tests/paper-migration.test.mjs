import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectPaperPreflight,
  collectPaperSourcePolicy,
} from "../packages/core/paper/paper.js";
import { writeLegacyPaperFixture } from "./helpers/legacy-paper-fixture.mjs";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";
import {
  planPaperMigration,
  writePaperMigration,
} from "../packages/core/paper/operations/scaffold.js";

const root = path.resolve(import.meta.dirname, "..");
const tagCommit = "a".repeat(40);
const tagObject = "b".repeat(40);

function installedRuntimeSha({
  name = "@kungfu-tech/buildchain",
  version = "4.0.2-alpha.41",
  npm = "",
  tags = "",
  gitStatus = 0,
  npmStatus = 0,
} = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paper-npm-runtime-"));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name, version }),
  );
  const shim = path.join(cwd, "shims");
  fs.mkdirSync(shim);
  for (const command of ["npm", "git"]) {
    fs.writeFileSync(
      path.join(shim, command),
      `#!${process.execPath}\n${
        command === "npm"
          ? `process.stdout.write(${JSON.stringify(npm)}); process.exit(${npmStatus});`
          : `const args = process.argv.slice(2); if (JSON.stringify(args) !== JSON.stringify(["ls-remote", "--exit-code", "https://github.com/kungfu-systems/buildchain.git", "refs/tags/v4.0.2-alpha.41", "refs/tags/v4.0.2-alpha.41^{}"])) process.exit(99); process.stdout.write(${JSON.stringify(tags)}); process.exit(${gitStatus});`
      }`,
      { mode: 0o755 },
    );
    // Windows resolves .cmd shims; a POSIX shebang alone falls through to real Git/npm.
    fs.writeFileSync(
      path.join(shim, `${command}.cmd`),
      `@echo off\r\n"${process.execPath}" "%~dp0${command}" %*\r\n`,
    );
  }
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { resolvePaperRuntimeGitSha } from ${JSON.stringify(new URL("../packages/core/paper/operations/runtime.js", import.meta.url).href)}; console.log(JSON.stringify(resolvePaperRuntimeGitSha(${JSON.stringify(cwd)})));`,
      ],
      {
        env: {
          ...process.env,
          PATH: `${shim}${path.delimiter}${process.env.PATH}`,
        },
        encoding: "utf8",
      },
    ),
  );
}

test("npm Paper runtime resolves exact official lightweight and annotated version tags when gitHead is absent", () => {
  const ref = "refs/tags/v4.0.2-alpha.41";
  assert.equal(
    installedRuntimeSha({ tags: `${tagCommit}\t${ref}\n` }),
    tagCommit,
  );
  assert.equal(
    installedRuntimeSha({
      tags: `${tagObject}\t${ref}\n${tagCommit}\t${ref}^{}\n`,
    }),
    tagCommit,
  );
  assert.equal(
    installedRuntimeSha({
      npm: JSON.stringify(tagObject),
      tags: `${tagCommit}\t${ref}\n`,
    }),
    tagObject,
  );
  for (const tags of [
    "",
    `${tagCommit}\t${ref}^{}\n`,
    `invalid\t${ref}\n`,
    `${tagCommit}\trefs/tags/v4-alpha\n`,
    `${tagCommit}\t${ref}\n${tagObject}\t${ref}\n`,
  ]) {
    assert.equal(installedRuntimeSha({ tags }), "", tags);
  }
  assert.equal(
    installedRuntimeSha({ tags: `${tagCommit}\t${ref}\n`, gitStatus: 1 }),
    "",
  );
  assert.equal(
    installedRuntimeSha({ tags: `${tagCommit}\t${ref}\n`, npmStatus: 1 }),
    "",
  );
  assert.equal(
    installedRuntimeSha({
      name: "@example/buildchain",
      tags: `${tagCommit}\t${ref}\n`,
    }),
    "",
  );
  assert.equal(
    installedRuntimeSha({ version: "^4.0.2", tags: `${tagCommit}\t${ref}\n` }),
    "",
  );
});

function retainedFixture(t) {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "paper-retained-migration-"),
  );
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  writeLegacyPaperFixture({ cwd });
  execFileSync("git", ["init", "-q", cwd]);
  commit(cwd);
  return cwd;
}
function commit(cwd) {
  execFileSync("git", ["add", "."], { cwd });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture: Paper source",
    ],
    { cwd },
  );
}

test("retained Paper guidance migrates to shared consumer instructions while preserving surrounding text", (t) => {
  const cwd = retainedFixture(t),
    agents = path.join(cwd, "AGENTS.md");
  const note = "Repository-owned note: old runtime examples are historical.\n";
  fs.writeFileSync(agents, note + fs.readFileSync(agents, "utf8"));
  commit(cwd);
  const result = writePaperMigration(
    planPaperMigration({ cwd, buildchainRoot: root }),
  );
  assert.equal(result.ok, true);
  const text = fs.readFileSync(agents, "utf8");
  assert(text.startsWith(note));
  assert.match(text, /buildchain:consumer:start/);
  assert.doesNotMatch(
    text,
    /buildchain:next-development:v1|buildchain:paper-agent-entry:v1/,
  );
  for (const [file, bytes] of Object.entries(consumerWorkflows()))
    assert.equal(fs.readFileSync(path.join(cwd, file), "utf8"), bytes);
});

test("Paper migration cannot retarget tool-maintained runtime locks through retired channel-root inputs", (t) => {
  const cwd = retainedFixture(t);
  for (const field of ["stableBuildchainRoot", "alphaBuildchainRoot"])
    assert.throws(
      () =>
        planPaperMigration({
          cwd,
          buildchainRoot: root,
          [field]: "/not-a-runtime-root",
        }),
      /retired channel-root/,
    );
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }),
    "",
  );
});

test("migrated Paper source policy requires the shared contract without a repository agent-entry controller", (t) => {
  const cwd = retainedFixture(t);
  writePaperMigration(planPaperMigration({ cwd, buildchainRoot: root }));
  assert.equal(
    fs.existsSync(path.join(cwd, ".buildchain/paper/agent-entry.json")),
    false,
  );
  const sourcePolicy = collectPaperSourcePolicy({ cwd });
  assert.equal(sourcePolicy.ok, true);
  assert.equal(sourcePolicy.localOnly, true);
  assert.equal(
    collectPaperPreflight({ cwd, offline: false }).publication.status,
    "not-observed",
  );
  fs.appendFileSync(
    path.join(cwd, ".github/workflows/buildchain.yml"),
    "# unowned caller change\n",
  );
  assert.equal(collectPaperSourcePolicy({ cwd }).ok, false);
});
