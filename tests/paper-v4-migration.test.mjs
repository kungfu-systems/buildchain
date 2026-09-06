import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createBuildchainContractWorld,
  finalizeBuildchainContractWorld,
} from "../packages/core/buildchain-contract.js";
import {
  collectPaperAgentEntry,
  collectPaperPreflight,
  planPaperMigration,
  planPaperScaffold,
  writePaperMigration,
  writePaperScaffold,
} from "../packages/core/paper.js";

const root = path.resolve(import.meta.dirname, "..");
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
  const stableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paper-v4-stable-"));
  init(stableRoot);
  const world = createBuildchainContractWorld({ root });
  world.product.version = "4.0.1";
  fs.mkdirSync(path.join(stableRoot, "dist/site"), { recursive: true });
  fs.writeFileSync(
    path.join(stableRoot, "package.json"),
    JSON.stringify({ name: "@kungfu-tech/buildchain", version: "4.0.1" }),
  );
  fs.writeFileSync(
    path.join(stableRoot, "dist/site/buildchain-contract.json"),
    JSON.stringify(finalizeBuildchainContractWorld(world)),
  );
  commit(stableRoot);
  return {
    cwd,
    stableRoot,
    options: {
      cwd,
      buildchainRoot: root,
      buildchainVersion: version,
      stableBuildchainRoot: stableRoot,
    },
  };
}

test("v4 paper migration preserves content and binds floating callers to distinct channel locks", () => {
  const { cwd, stableRoot, options } = fixture();
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
  for (const name of ["build.yml", "verify.yml", "paper-release.yml"]) {
    const text = fs.readFileSync(
      path.join(cwd, ".github/workflows", name),
      "utf8",
    );
    assert.match(text, /@v4-alpha/);
    assert.doesNotMatch(
      text,
      /buildchain[^\n]*@[0-9a-f]{40}|buildchain-ref: [0-9a-f]{40}|@v3/,
    );
    if (name === "paper-release.yml") {
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
  assert.equal(alpha.buildchain.resolvedSha, git(root, "rev-parse", "HEAD"));
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
  const { cwd, stableRoot, options } = fixture();
  writePaperMigration(planPaperMigration(options));
  const env = {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_HEAD_REF: "feature/paper",
    GITHUB_BASE_REF: "dev/v0/v0.1",
  };
  for (const runtimeRoot of [root, stableRoot]) {
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
  const { cwd, options } = fixture();
  writePaperMigration(planPaperMigration(options));
  for (const agentEntryMode of ["ci", "local"]) {
    const result = collectPaperPreflight({
      cwd,
      buildchainRoot: root,
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
    buildchainRoot: root,
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
