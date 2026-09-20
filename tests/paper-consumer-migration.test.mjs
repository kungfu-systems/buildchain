import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  planPaperMigration,
  writePaperMigration,
} from "../packages/core/paper/operations/scaffold.js";
import {
  sha256Text,
  stableJson,
} from "../packages/core/paper/paper-repository.js";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";
import { compileConsumerPlan } from "../packages/core/consumer/contract/plan.js";
import { collectPaperPreflight } from "../packages/core/paper/paper.js";
const root = path.resolve(import.meta.dirname, "..");
function write(cwd, relative, content) {
  const target = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
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
      "fixture: retained Paper consumer",
    ],
    { cwd },
  );
}
function fixture(t) {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "paper-migration-contract-"),
  );
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  write(
    cwd,
    ".buildchain/buildchain.toml",
    `schema = 1
[project]
type = "publication-artifact"
name = "paper-example"
[publication]
kind = "paper"
title = "Retained title"
version = "2.3.0-alpha.1"
primary_artifact = "_build/paper.pdf"
artifact_paths = ["_build/paper.pdf", "_build/appendix.pdf"]
metadata_paths = ["README.md"]
source_paths = ["paper"]
site_consumers = ["https://papers.example.test"]
[publish]
kind = "npm-paper-package"
package = "@example/paper-example"
auth = "trusted-publishing"
[lifecycle.build]
commands = ["make pdf", "make appendix"]
[lifecycle.verify]
command = "make check"
`,
  );
  write(
    cwd,
    "package.json",
    JSON.stringify({
      name: "@example/paper-example",
      private: true,
      packageManager: "pnpm@11.7.0",
      scripts: {
        "paper:preflight": "buildchain paper preflight --json",
        "paper:work:submit": "buildchain paper work submit",
        lint: "make lint",
      },
      devDependencies: { "@kungfu-tech/buildchain": "4.0.1" },
    }),
  );
  write(cwd, "paper/main.tex", "% Existing reviewed paper.\n");
  write(cwd, "README.md", "# Existing source documentation\n");
  write(
    cwd,
    "AGENTS.md",
    "Repository-owned instruction.\n<!-- buildchain:paper-agent-entry:v1:start -->\nOld required work command.\n<!-- buildchain:paper-agent-entry:v1:end -->\n<!-- buildchain:next-development:v1:start -->\nOld controller command.\n<!-- buildchain:next-development:v1:end -->\n",
  );
  for (const [file, callee] of [
    ["build.yml", "public-build-publication.yml"],
    ["verify.yml", "public-build-check.yml"],
    ["public-release-paper.yml", "public-release-paper.yml"],
  ])
    write(
      cwd,
      `.github/workflows/${file}`,
      `name: Legacy fixture\non: [push]\njobs:\n  product:\n    uses: kungfu-systems/buildchain/.github/workflows/${callee}@v4\n`,
    );
  // Synthetic historical contract records; these never grant provider authority.
  for (const [file, contract, key] of [
    [
      "provisioning-authority",
      "kungfu-buildchain-paper-provisioning-authority",
      "authorityDigest",
    ],
    ["agent-entry", "kungfu-buildchain-paper-agent-entry", "entryDigest"],
  ]) {
    const record = { schemaVersion: 1, contract };
    write(
      cwd,
      `.buildchain/paper/${file}.json`,
      JSON.stringify({ ...record, [key]: sha256Text(stableJson(record)) }),
    );
  }
  write(cwd, ".buildchain-version", "4.0.1\n");
  write(cwd, ".buildchain/contract-lock.json", '{"historical":"stable"}\n');
  write(
    cwd,
    ".buildchain/alpha-contract-lock.json",
    '{"historical":"alpha"}\n',
  );
  write(
    cwd,
    ".buildchain/release-state/retained.json",
    '{"historical":"complete-publication"}\n',
  );
  execFileSync("git", ["init", "-q", cwd]);
  commit(cwd);
  return cwd;
}
function plan(cwd) {
  return planPaperMigration({ cwd, buildchainRoot: root });
}
function bytes(cwd, file) {
  return fs.readFileSync(path.join(cwd, file), "utf8");
}

test("schema-1 Paper migration retains product commands, metadata and historical bytes with only the shared pair", (t) => {
  const cwd = fixture(t);
  const protectedFiles = [
    "paper/main.tex",
    "README.md",
    ".buildchain/contract-lock.json",
    ".buildchain/alpha-contract-lock.json",
    ".buildchain/release-state/retained.json",
  ];
  const before = Object.fromEntries(
    protectedFiles.map((file) => [file, bytes(cwd, file)]),
  );
  const migration = plan(cwd);
  assert.equal(migration.ok, true);
  assert.equal(migration.summary.remove, 6);
  assert.equal(
    fs.existsSync(path.join(cwd, ".github/workflows/build.yml")),
    true,
    "planning is read-only",
  );
  const result = writePaperMigration(migration);
  assert.equal(result.ok, true);
  assert.equal(result.removed.length, 6);
  assert.equal(result.idempotent, false);
  for (const [file, expected] of Object.entries(before))
    assert.equal(bytes(cwd, file), expected, file);
  for (const [file, expected] of Object.entries(consumerWorkflows()))
    assert.equal(bytes(cwd, file), expected, file);
  assert.deepEqual(fs.readdirSync(path.join(cwd, ".github/workflows")).sort(), [
    "buildchain-recover.yml",
    "buildchain.yml",
  ]);
  const compiled = compileConsumerPlan(
    bytes(cwd, ".buildchain/buildchain.toml"),
  );
  assert.deepEqual(compiled.products[0].build, ["make pdf", "make appendix"]);
  assert.deepEqual(compiled.products[0].verify, ["make check"]);
  assert.deepEqual(
    compiled.products[0].artifacts.map((x) => x.path),
    ["_build/paper.pdf", "_build/appendix.pdf"],
  );
  assert.equal(compiled.products[0].targets[0].provider, "github-release");
  const pkg = JSON.parse(bytes(cwd, "package.json"));
  assert.equal(pkg.version, "2.3.0-alpha.1");
  assert.deepEqual(pkg.scripts, { lint: "make lint" });
  const metadata = JSON.parse(bytes(cwd, "paper/publication-metadata.json"));
  assert.equal(metadata.title, "Retained title");
  assert.equal(metadata.version, undefined);
  assert.deepEqual(metadata.site_consumers, ["https://papers.example.test"]);
  const agents = bytes(cwd, "AGENTS.md");
  assert.match(agents, /^Repository-owned instruction/);
  assert.match(agents, /buildchain:consumer:start/);
  assert.doesNotMatch(
    agents,
    /Old required|Old controller|next-development:v1|paper-agent-entry:v1/,
  );
  assert.equal(collectPaperPreflight({ cwd }).ok, true);
  commit(cwd);
  assert.equal(writePaperMigration(plan(cwd)).idempotent, true);
});

for (const [name, file, content, reason] of [
  [
    "extra workflow",
    ".github/workflows/user.yml",
    "on: [push]\njobs: {}\n",
    /Unowned/,
  ],
  [
    "local job added to legacy caller",
    ".github/workflows/build.yml",
    "on: [push]\njobs:\n  user:\n    runs-on: ubuntu-latest\n    steps: []\n",
    /Unowned/,
  ],
  [
    "corrupt controller record",
    ".buildchain/paper/agent-entry.json",
    '{"contract":"kungfu-buildchain-paper-agent-entry","entryDigest":"wrong"}',
    /unverified/,
  ],
  [
    "owned metadata collision",
    "paper/publication-metadata.json",
    "User metadata\n",
    /overwrite product metadata/,
  ],
])
  test(`migration refuses ${name} without changing any source`, (t) => {
    const cwd = fixture(t);
    write(cwd, file, content);
    commit(cwd);
    const original = bytes(cwd, ".buildchain/buildchain.toml");
    assert.throws(() => plan(cwd), reason);
    assert.equal(bytes(cwd, ".buildchain/buildchain.toml"), original);
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }),
      "",
    );
  });

test("migration rejects ambiguous version authority and unrepresentable lifecycle settings", (t) => {
  for (const mutate of [
    (cwd) => {
      const pkg = JSON.parse(bytes(cwd, "package.json"));
      pkg.version = "9.0.0";
      write(cwd, "package.json", JSON.stringify(pkg));
    },
    (cwd) =>
      write(
        cwd,
        ".buildchain/buildchain.toml",
        bytes(cwd, ".buildchain/buildchain.toml").replace(
          'command = "make check"',
          'command = "make check"\nretries = 2',
        ),
      ),
  ]) {
    const cwd = fixture(t);
    mutate(cwd);
    commit(cwd);
    assert.throws(() => plan(cwd), /versions disagree|Move verify/);
    assert.equal(
      fs.existsSync(path.join(cwd, ".github/workflows/buildchain.yml")),
      false,
    );
  }
});

test("migration rejects stale plans before deleting legacy files", (t) => {
  const cwd = fixture(t),
    target = path.join(cwd, ".buildchain/paper/agent-entry.json");
  const migration = plan(cwd);
  fs.appendFileSync(target, "\n");
  assert.throws(
    () => writePaperMigration(migration),
    /source changed after planning/,
  );
  assert.equal(
    fs.existsSync(path.join(cwd, ".github/workflows/build.yml")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(cwd, ".github/workflows/buildchain.yml")),
    false,
  );
});

test("migration refuses a symlinked legacy control directory before reading or deleting its files", (t) => {
  const cwd = fixture(t),
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "paper-control-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const controls = path.join(cwd, ".buildchain/paper"),
    moved = path.join(outside, "controls");
  const before = bytes(cwd, ".buildchain/paper/agent-entry.json");
  fs.renameSync(controls, moved);
  fs.symlinkSync(moved, controls, "junction");
  assert.throws(() => plan(cwd), /regular files and directories/);
  assert.equal(
    fs.readFileSync(path.join(moved, "agent-entry.json"), "utf8"),
    before,
  );
  assert.equal(
    fs.existsSync(path.join(cwd, ".github/workflows/buildchain.yml")),
    false,
  );
});

test("migration refuses a redirected root even if another checkout has identical committed bytes", (t) => {
  const cwd = fixture(t),
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "paper-root-outside-")),
    saved = `${cwd}-saved`;
  t.after(() => {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(saved, { recursive: true, force: true });
  });
  const migration = plan(cwd),
    original = bytes(cwd, ".buildchain/buildchain.toml");
  fs.cpSync(cwd, outside, { recursive: true });
  fs.renameSync(cwd, saved);
  fs.symlinkSync(outside, cwd, "junction");
  assert.throws(() => writePaperMigration(migration), /root changed/);
  assert.equal(bytes(outside, ".buildchain/buildchain.toml"), original);
  assert.equal(bytes(saved, ".buildchain/buildchain.toml"), original);
});
