import YAML from "yaml";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nextDevelopmentAgentInstructions } from "../packages/core/release/next-development-projection.js";
import {
  createBuildchainContractWorld,
  finalizeBuildchainContractWorld,
} from "../packages/core/contracts/buildchain-contract.js";
import { collectPaperAgentEntry } from "../packages/core/paper/paper-agent-entry.js";
import { collectPaperPreflight } from "../packages/core/paper/paper.js";
import { planPaperMigration, planPaperScaffold, writePaperMigration, writePaperScaffold } from "../packages/core/paper/operations/scaffold.js";

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

const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json")),
).version;
function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function init(cwd) {
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Buildchain Test");
  git(cwd, "config", "user.email", "test@example.test");
}
function commit(cwd) {
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture: paper source");
}
function channelFixture(version) {
  const channel = version.includes("-") ? "alpha" : "stable";
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `paper-v4-${channel}-`),
  );
  init(runtimeRoot);
  const world = createBuildchainContractWorld({ root });
  world.product.version = version;
  fs.mkdirSync(path.join(runtimeRoot, "dist/site"), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, "package.json"),
    JSON.stringify({ name: "@kungfu-tech/buildchain", version }),
  );
  fs.writeFileSync(
    path.join(runtimeRoot, "dist/site/buildchain-contract.json"),
    JSON.stringify(finalizeBuildchainContractWorld(world)),
  );
  commit(runtimeRoot);
  return runtimeRoot;
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paper-v4-consumer-"));
  writePaperScaffold(
    planPaperScaffold({
      cwd,
      buildchainRoot: root,
      buildchainVersion: "3.0.4-alpha.13",
      name: "paper-example",
      title: "Existing paper",
      packageName: "@example/paper-example",
      repository: "example/paper-example",
    }),
  );
  const ignorePath = path.join(cwd, ".gitignore");
  fs.writeFileSync(
    ignorePath,
    fs.readFileSync(ignorePath, "utf8").replace(/^node_modules\/\n/m, ""),
  );
  init(cwd);
  commit(cwd);
  const stableRoot = channelFixture("4.0.1");
  const alphaRoot = channelFixture("4.0.2-alpha.40");
  return {
    cwd,
    stableRoot,
    alphaRoot,
    alphaRuntime: {
      buildchainRoot: root,
      buildchainVersion: "4.0.2-alpha.40",
      buildchainSha: git(alphaRoot, "rev-parse", "HEAD"),
    },
    options: {
      cwd,
      buildchainRoot: root,
      buildchainVersion: version,
      stableBuildchainRoot: stableRoot,
      alphaBuildchainRoot: alphaRoot,
    },
  };
}

test("generated v4 Verify grants the public callee read permissions without write authority", () => {
  const { cwd, options } = fixture();
  const permissions = text => YAML.parse(text).permissions;
  assert.deepEqual(
    permissions(
      fs.readFileSync(path.join(cwd, ".github/workflows/verify.yml"), "utf8"),
    ),
    { contents: "read" },
  );
  assert.equal(writePaperMigration(planPaperMigration(options)).ok, true);
  const caller = permissions(
    fs.readFileSync(path.join(cwd, ".github/workflows/verify.yml"), "utf8"),
  );
  const callee = permissions(
    fs.readFileSync(path.join(root, ".github/workflows/public-build-check.yml"), "utf8"),
  );
  assert.deepEqual(caller, callee);
  assert(Object.values(caller).every((permission) => permission === "read"));
});

test("Paper guidance resolves installed script and official ADR without rewriting surrounding instructions", () => {
  const { cwd, options } = fixture();
  const file = path.join(cwd, "AGENTS.md");
  const note =
    "Local note: `architecture/decisions/0002-next-development-transition.md` and node packages/core/release/commands/next-development-transition.mjs remain literal examples.\n";
  fs.writeFileSync(file, note + fs.readFileSync(file, "utf8"));
  commit(cwd);
  assert.equal(writePaperMigration(planPaperMigration(options)).ok, true);
  const text = fs.readFileSync(file, "utf8");
  assert(text.startsWith(note));
  const section = text.split(
    "<!-- buildchain:next-development:v1:start -->",
  )[1];
  const script = section.match(
    /node node_modules\/@kungfu-tech\/buildchain\/(packages\/core\/release\/commands\/[^ ]+) materialize/,
  )[1];
  assert(fs.existsSync(path.join(root, script)));
  const adr = section.match(
    /https:\/\/github.com\/kungfu-systems\/buildchain\/blob\/v4\/(architecture\/[^)]+)\)/,
  )[1];
  assert(fs.existsSync(path.join(root, adr)));
  assert.match(
    nextDevelopmentAgentInstructions(),
    /node packages\/core\/release\/commands\/next-development-transition.mjs materialize/,
  );
  assert.doesNotMatch(section, /\nnode scripts\//);
});

test("v4 paper migration preserves content and binds floating callers to distinct channel locks", () => {
  const { cwd, stableRoot, alphaRoot, options } = fixture();
  const paper = fs.readFileSync(path.join(cwd, "paper/main.tex"), "utf8");
  const plan = planPaperMigration(options);
  assert.equal(plan.ok, true);
  assert.equal(writePaperMigration(plan).ok, true);
  fs.mkdirSync(path.join(cwd, "node_modules"));
  fs.writeFileSync(path.join(cwd, "node_modules", "installed"), "fixture");
  assert.equal(
    git(cwd, "check-ignore", "node_modules/installed"),
    "node_modules/installed",
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "paper/main.tex"), "utf8"),
    paper,
  );
  for (const name of ["build.yml", "verify.yml", "public-release-paper.yml"]) {
    const text = fs.readFileSync(
      path.join(cwd, ".github/workflows", name),
      "utf8",
    );
    assert.match(text, /@v4-alpha/);
    assert.doesNotMatch(
      text,
      /buildchain[^\n]*@[0-9a-f]{40}|buildchain-ref: [0-9a-f]{40}|@v3/,
    );
    if (name === "public-release-paper.yml") {
      assert.match(text, /@v4\n/);
      assert.match(text, /startsWith\(github.ref_name, 'release\/'\)/);
    }
  }
  const stable = JSON.parse(
    fs.readFileSync(path.join(cwd, ".buildchain/contract-lock.json")),
  );
  const alpha = JSON.parse(
    fs.readFileSync(path.join(cwd, ".buildchain/alpha-contract-lock.json")),
  );
  assert.equal(stable.buildchain.ref, "v4");
  assert.equal(
    stable.buildchain.resolvedSha,
    git(stableRoot, "rev-parse", "HEAD"),
  );
  assert.equal(alpha.buildchain.ref, "v4-alpha");
  assert.equal(
    alpha.buildchain.resolvedSha,
    git(alphaRoot, "rev-parse", "HEAD"),
  );
  const preflight = collectPaperPreflight({
    cwd,
    buildchainRoot: root,
    offline: true,
  });
  assert.equal(
    preflight.checks.find((check) => check.id === "provisioning.authority")
      .status,
    "pass",
    JSON.stringify(preflight),
  );
  assert.equal(
    preflight.checks.find((check) => check.id === "agent-entry.runtime-source")
      .status,
    "pass",
  );
  commit(cwd);
  assert.equal(
    planPaperMigration(options).changes.every(
      (change) => change.action === "unchanged",
    ),
    true,
  );
  fs.appendFileSync(path.join(cwd, ".buildchain/contract-lock.json"), "\n");
  const rejected = collectPaperPreflight({
    cwd,
    buildchainRoot: root,
    offline: true,
  });
  assert.equal(
    rejected.checks.find((check) => check.id === "provisioning.authority")
      .status,
    "fail",
  );
});

test("v4 paper migration rejects a dirty or wrong-channel explicit root", () => {
  const { stableRoot, options } = fixture();
  fs.appendFileSync(path.join(stableRoot, "package.json"), "\n");
  assert.throws(() => planPaperMigration(options), /committed runtime bytes/);
  fs.writeFileSync(
    path.join(stableRoot, "package.json"),
    JSON.stringify({
      name: "@kungfu-tech/buildchain",
      version: "4.0.2-alpha.40",
    }),
  );
  commit(stableRoot);
  assert.throws(() => planPaperMigration(options), /does not belong to v4/);
});

test("v4 paper CI accepts only the two bound runtime sources", () => {
  const { cwd, stableRoot, alphaRoot, options } = fixture();
  writePaperMigration(planPaperMigration(options));
  const env = {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_HEAD_REF: "feature/paper",
    GITHUB_BASE_REF: "dev/v0/v0.1",
  };
  for (const runtimeRoot of [alphaRoot, stableRoot]) {
    assert.equal(
      collectPaperAgentEntry({
        cwd,
        mode: "ci",
        env,
        buildchainSha: git(runtimeRoot, "rev-parse", "HEAD"),
      }).ok,
      true,
    );
  }
  assert.equal(
    collectPaperAgentEntry({
      cwd,
      mode: "ci",
      env,
      buildchainSha: "a".repeat(40),
    }).ok,
    false,
  );
});

test("v4 paper preflight admits compatible floating SHA drift only in CI", () => {
  const { cwd, alphaRuntime, options } = fixture();
  writePaperMigration(planPaperMigration(options));
  for (const agentEntryMode of ["ci", "local"]) {
    const result = collectPaperPreflight({
      cwd,
      ...alphaRuntime,
      buildchainSha: "b".repeat(40),
      offline: true,
      agentEntryMode,
    });
    assert.equal(
      result.checks.find(({ id }) => id === "agent-entry.runtime-source")
        .status,
      agentEntryMode === "ci" ? "pass" : "fail",
      JSON.stringify(result),
    );
  }
  const lockPath = path.join(cwd, ".buildchain/alpha-contract-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath));
  lock.buildchain.majorLine = "v3";
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  const rejected = collectPaperPreflight({
    cwd,
    ...alphaRuntime,
    buildchainSha: "b".repeat(40),
    offline: true,
    agentEntryMode: "ci",
  });
  assert.equal(
    rejected.checks.find(({ id }) => id === "agent-entry.runtime-source")
      .status,
    "fail",
  );
});
