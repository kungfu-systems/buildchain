import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { materializeCommandShim } from "./helpers/command-shim.mjs";
import {
  planPaperMigration,
  writePaperMigration,
  planPaperScaffold,
  writePaperScaffold,
} from "../packages/core/paper/operations/scaffold.js";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";
import { inspectConsumerContract } from "../packages/core/consumer/contract/inspection.js";
import { compileConsumerPlan } from "../packages/core/consumer/contract/plan.js";
import { collectPaperPreflight } from "../packages/core/paper/paper.js";
import { collectPaperStatus } from "../packages/core/paper/operations/status.js";
import { collectPaperAgentEntry } from "../packages/core/paper/paper-agent-entry.js";
import { paperDevelopmentRef } from "../packages/core/paper/paper-repository.js";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "bin/buildchain.mjs");
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paper-consumer-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
function options(cwd) {
  return {
    cwd,
    buildchainRoot: root,
    name: "paper-example",
    title: "A Reviewed Paper",
    repository: "example/paper-example",
    version: "2.3.0-alpha.1",
    siteBaseUrl: "https://papers.example.test",
  };
}
function generate(cwd) {
  const plan = planPaperScaffold(options(cwd));
  assert.equal(plan.ok, true);
  return writePaperScaffold(plan);
}

test("Paper source scaffold uses the common schema-2 configuration and byte-identical caller pair", (t) => {
  const cwd = fixture(t);
  const generated = generate(cwd);
  const files = Object.fromEntries(
    generated.written.map((file) => [
      file,
      fs.readFileSync(path.join(cwd, file), "utf8"),
    ]),
  );
  const plan = compileConsumerPlan(files[".buildchain/buildchain.toml"]);
  assert.equal(plan.products[0].type, "paper");
  assert.deepEqual(plan.products[0].build, ["make pdf"]);
  assert.deepEqual(plan.products[0].verify, ["make check"]);
  assert.equal(plan.products[0].targets[0].provider, "github-release");
  assert.equal(plan.channels[0].to, "dev/v2/v2.3");
  assert.deepEqual(plan.version.files, [
    { path: "package.json", format: "json", key: "version" },
  ]);
  for (const [name, bytes] of Object.entries(consumerWorkflows()))
    assert.equal(files[name], bytes);
  assert.deepEqual(fs.readdirSync(path.join(cwd, ".github/workflows")).sort(), [
    "buildchain-recover.yml",
    "buildchain.yml",
  ]);
  assert.deepEqual(fs.readdirSync(path.join(cwd, ".buildchain")), [
    "buildchain.toml",
  ]);
  const pkg = JSON.parse(files["package.json"]);
  assert.equal(pkg.version, "2.3.0-alpha.1");
  assert.equal(pkg.description, "A Reviewed Paper");
  assert.equal(pkg.homepage, "https://papers.example.test");
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.scripts, { build: "make pdf", check: "make check" });
  assert.doesNotMatch(
    files["AGENTS.md"],
    /next-development:v1|paper-agent-entry|request-json|compare-and-swap/,
  );
  const admission = inspectConsumerContract(files);
  assert.equal(admission.ok, true, admission.issues.join("\n"));
  const validation = JSON.parse(
    execFileSync(
      process.execPath,
      [
        cli,
        "validate",
        "--cwd",
        cwd,
        "--require-lifecycle-stages",
        "build,verify",
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(validation.config.schema, 2);
  assert.equal(
    writePaperScaffold(planPaperScaffold(options(cwd))).idempotent,
    true,
  );
});

test("scaffold and current Paper preflight/status need no npm or GitHub account operation", (t) => {
  const cwd = fixture(t),
    shims = fixture(t),
    attempts = path.join(shims, "provider-called");
  for (const name of ["npm", "gh"])
    materializeCommandShim(
      path.join(shims, name),
      `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(attempts)}, process.argv.join(' ') + '\\n'); process.exit(97);\n`,
    );
  const env = {
    ...process.env,
    PATH: `${shims}${path.delimiter}${process.env.PATH}`,
  };
  const scaffold = spawnSync(
    process.execPath,
    [
      cli,
      "paper",
      "scaffold",
      "--cwd",
      cwd,
      "--name",
      "paper-example",
      "--repository",
      "example/paper-example",
      "--write",
      "--json",
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(scaffold.status, 0, scaffold.stderr);
  for (const command of ["preflight", "status"]) {
    const run = spawnSync(
      process.execPath,
      [cli, "paper", command, "--cwd", cwd, "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.localOnly, true);
    assert.equal(result.publication.status, "not-observed");
  }
  assert.equal(fs.existsSync(attempts), false);
});

test("Paper status rejects a mutated caller without claiming publication", (t) => {
  const cwd = fixture(t);
  generate(cwd);
  fs.appendFileSync(
    path.join(cwd, ".github/workflows/buildchain.yml"),
    "# local mutation\n",
  );
  for (const result of [
    collectPaperPreflight({ cwd }),
    collectPaperStatus({ cwd }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.id === "workflow.consumer-pair")
        .status,
      "fail",
    );
    assert.equal(result.publication.status, "not-observed");
  }
});

test("existing workflows block Paper scaffold before any product file is written", (t) => {
  const cwd = fixture(t);
  fs.mkdirSync(path.join(cwd, ".github/workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".github/workflows/old.yml"),
    "owned workflow\n",
  );
  const plan = planPaperScaffold(options(cwd));
  assert.equal(plan.ok, false);
  assert.equal(writePaperScaffold(plan).ok, false);
  assert.equal(fs.existsSync(path.join(cwd, "package.json")), false);
  assert.equal(
    fs.readFileSync(path.join(cwd, ".github/workflows/old.yml"), "utf8"),
    "owned workflow\n",
  );
});

test("Paper scaffold validates all existing file bytes before writing a missing file", (t) => {
  const cwd = fixture(t);
  generate(cwd);
  fs.rmSync(path.join(cwd, "LICENSE"));
  const plan = planPaperScaffold(options(cwd));
  assert.equal(plan.ok, true);
  fs.appendFileSync(path.join(cwd, "README.md"), "\nNew user work.\n");
  assert.throws(() => writePaperScaffold(plan), /race detected/);
  assert.equal(fs.existsSync(path.join(cwd, "LICENSE")), false);
});

test("Paper scaffold rejects symlinked write parents before reading or writing through them", (t) => {
  const cwd = fixture(t),
    outside = fixture(t);
  fs.mkdirSync(path.join(cwd, ".github"));
  fs.symlinkSync(outside, path.join(cwd, ".github/workflows"), "junction");
  assert.throws(
    () => planPaperScaffold(options(cwd)),
    /regular files and directories/,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(path.join(cwd, ".buildchain")), false);
});

test("Paper scaffold detects a workflow added after planning", (t) => {
  const cwd = fixture(t);
  const plan = planPaperScaffold(options(cwd));
  fs.mkdirSync(path.join(cwd, ".github/workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".github/workflows/old.yml"),
    "owned workflow\n",
  );
  assert.throws(() => writePaperScaffold(plan), /inventory changed/);
  assert.equal(fs.existsSync(path.join(cwd, "package.json")), false);
});

test("Paper scaffold refuses a root redirected after planning", (t) => {
  const parent = fixture(t),
    outside = fixture(t),
    cwd = path.join(parent, "new-paper");
  const plan = planPaperScaffold(options(cwd));
  fs.symlinkSync(outside, cwd, "junction");
  assert.throws(() => writePaperScaffold(plan), /root changed/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("Paper scaffold rejects retired product-specific runtime selectors", (t) => {
  const cwd = fixture(t);
  for (const ref of ["v3", "v4-alpha", "a".repeat(40), "train/v4/v4.1/example"])
    assert.throws(
      () => planPaperScaffold({ ...options(cwd), buildchainRef: ref }),
      /shared published v4 caller/,
    );
  assert.deepEqual(fs.readdirSync(cwd), []);
});

function commitSource(cwd) {
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["add", "."], { cwd });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Paper Fixture",
      "-c",
      "user.email=paper@example.test",
      "commit",
      "-qm",
      "fixture: product source",
    ],
    { cwd },
  );
}

test("migration of a current Paper consumer is idempotent and creates no legacy controller files", (t) => {
  const cwd = fixture(t);
  generate(cwd);
  commitSource(cwd);
  const plan = planPaperMigration(options(cwd));
  assert.equal(plan.ok, true);
  assert.equal(
    plan.changes.every((change) => change.action === "unchanged"),
    true,
  );
  assert.equal(writePaperMigration(plan).idempotent, true);
  assert.deepEqual(fs.readdirSync(path.join(cwd, ".buildchain")), [
    "buildchain.toml",
  ]);
});

test("Paper migration rejects a changed product source even when its planned control files are unchanged", (t) => {
  const cwd = fixture(t);
  generate(cwd);
  commitSource(cwd);
  const plan = planPaperMigration(options(cwd));
  fs.appendFileSync(path.join(cwd, "paper/main.tex"), "\n% New work.\n");
  assert.throws(
    () => writePaperMigration(plan),
    /source changed after planning/,
  );
});

test("current Paper agent verification uses TOML lineage without legacy runtime pins or helper scripts", (t) => {
  const cwd = fixture(t),
    remote = fixture(t);
  generate(cwd);
  commitSource(cwd);
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["branch", "-M", "dev/v2/v2.3"], { cwd });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd });
  execFileSync("git", ["push", "-u", "origin", "dev/v2/v2.3"], { cwd });
  assert.equal(paperDevelopmentRef(cwd), "dev/v2/v2.3");
  assert.equal(collectPaperAgentEntry({ cwd }).ok, true);
  assert.equal(
    collectPaperPreflight({ cwd, agentEntryMode: "local" }).ok,
    false,
  );
  execFileSync("git", ["switch", "-c", "feature/current-paper"], { cwd });
  const verified = collectPaperPreflight({ cwd, agentEntryMode: "local" });
  assert.equal(verified.ok, true, JSON.stringify(verified.checks));
  assert.equal(verified.context.developmentRef, "dev/v2/v2.3");
  assert.equal(verified.localOnly, true);
  assert.equal(verified.publication.status, "not-observed");
  for (const target of ["dev/v2/v2.3", "main"])
    assert.equal(
      collectPaperAgentEntry({
        cwd,
        mode: "ci",
        env: {
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_HEAD_REF: "feature/current-paper",
          GITHUB_BASE_REF: target,
        },
      }).ok,
      target === "dev/v2/v2.3",
    );
  const invoked = spawnSync(
    process.execPath,
    [cli, "paper", "agent", "verify", "--cwd", cwd, "--offline", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.equal(JSON.parse(invoked.stdout).context.mode, "local");
  assert.equal(
    fs.existsSync(path.join(cwd, ".buildchain/paper/agent-entry.json")),
    false,
  );
  assert.equal(fs.existsSync(path.join(cwd, ".buildchain-version")), false);
  fs.appendFileSync(
    path.join(cwd, ".github/workflows/buildchain.yml"),
    "# drift\n",
  );
  assert.equal(collectPaperAgentEntry({ cwd }).ok, false);
});

test("Paper work refuses ambiguous development targets instead of inferring one from package version", (t) => {
  const cwd = fixture(t);
  generate(cwd);
  fs.appendFileSync(
    path.join(cwd, ".buildchain/buildchain.toml"),
    '\n[[channels]]\nfrom = "feature/other"\nto = "dev/v9/v9.0"\noperation = "develop"\n',
  );
  assert.throws(
    () => paperDevelopmentRef(cwd),
    /unambiguous development target/,
  );
});
