import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadBuildchainConfig } from "../packages/core/buildchain-config.js";
import {
  PUBLICATION_REHEARSAL_AGENT_SECTION_END,
  PUBLICATION_REHEARSAL_AGENT_SECTION_START,
  PUBLICATION_REHEARSAL_WORKFLOW_PATH,
  assertPublicationRehearsalConfig,
} from "../packages/core/publication-rehearsal-projection.js";
import {
  PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
  PUBLICATION_REHEARSAL_COMMAND,
  RELEASE_LOCAL_CONSTRUCTIBILITY_ADR,
  RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT,
} from "../packages/core/publication-rehearsal-runtime.js";
import {
  planPaperMigration,
  planPaperScaffold,
  writePaperScaffold,
} from "../packages/core/paper.js";
import { initBuildchainRepo } from "../scripts/init-repo.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
).version;
const buildchainSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

function tempDir(name) {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), `buildchain-rehearsal-projection-${name}-`),
  );
}

function assertProjection(cwd) {
  const config = fs.readFileSync(
    path.join(cwd, ".buildchain", "buildchain.toml"),
    "utf8",
  );
  const workflow = fs.readFileSync(
    path.join(cwd, PUBLICATION_REHEARSAL_WORKFLOW_PATH),
    "utf8",
  );
  const agents = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
  for (const text of [config, workflow, agents]) {
    assert.match(text, new RegExp(PUBLICATION_REHEARSAL_CAPSULE_CONTRACT));
  }
  assert.match(config, new RegExp(RELEASE_LOCAL_CONSTRUCTIBILITY_ADR));
  assert.match(config, new RegExp(RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT));
  assert.ok(agents.includes(PUBLICATION_REHEARSAL_COMMAND));
  assert.match(workflow, /\.github\/workflows\/release-tail\.yml@/u);
  assert.match(workflow, /capsule-path:/u);
  assert.match(workflow, /capsule-root:/u);
  assert.equal(
    assertPublicationRehearsalConfig(loadBuildchainConfig(cwd).config).command,
    PUBLICATION_REHEARSAL_COMMAND,
  );
}

test("every fresh init variant projects the rehearsal contract, workflow, and Agent entry", () => {
  for (const type of [
    "package",
    "native",
    "web-surface",
    "infra-contract",
    "publication-artifact",
    "anchored-package",
  ]) {
    const cwd = tempDir(type);
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      `${JSON.stringify({ name: `fixture-${type}`, version: "0.1.0" })}\n`,
    );
    initBuildchainRepo({ cwd, type, packageManager: "pnpm" });
    assertProjection(cwd);
  }
});

test("Paper scaffold and migration restore every managed rehearsal projection", () => {
  const cwd = tempDir("paper");
  const plan = planPaperScaffold({
    cwd,
    buildchainRoot: repositoryRoot,
    buildchainVersion: packageVersion,
    buildchainRef: "v3",
    buildchainSha,
    name: "paper-rehearsal-fixture",
    title: "Paper Rehearsal Fixture",
    packageName: "@example/paper-rehearsal-fixture",
    repository: "example/paper-rehearsal-fixture",
    version: "0.1.0-alpha.0",
  });
  assert.equal(plan.ok, true);
  const written = writePaperScaffold(plan);
  assert.equal(written.ok, true);
  assertProjection(cwd);
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["publication:rehearse"],
    PUBLICATION_REHEARSAL_COMMAND,
  );

  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.name", "Buildchain Test"], { cwd });
  execFileSync("git", ["config", "user.email", "buildchain@example.test"], {
    cwd,
  });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "initial scaffold"], { cwd });

  const configPath = path.join(cwd, ".buildchain", "buildchain.toml");
  const agentsPath = path.join(cwd, "AGENTS.md");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace(/\n\[publication_rehearsal\][\s\S]*$/u, "\n"),
  );
  const agents = fs.readFileSync(agentsPath, "utf8");
  const start = agents.indexOf(PUBLICATION_REHEARSAL_AGENT_SECTION_START);
  const end = agents.indexOf(PUBLICATION_REHEARSAL_AGENT_SECTION_END);
  fs.writeFileSync(
    agentsPath,
    `${agents.slice(0, start)}${agents.slice(end + PUBLICATION_REHEARSAL_AGENT_SECTION_END.length)}`,
  );
  fs.writeFileSync(
    path.join(cwd, PUBLICATION_REHEARSAL_WORKFLOW_PATH),
    "name: Stale Publication Rehearsal\n",
  );
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-qm", "remove rehearsal projection"], {
    cwd,
  });

  const migration = planPaperMigration({
    cwd,
    buildchainRoot: repositoryRoot,
    buildchainVersion: packageVersion,
    buildchainSha,
  });
  const byPath = new Map(
    migration.changes.map((entry) => [entry.path, entry.action]),
  );
  assert.equal(byPath.get(".buildchain/buildchain.toml"), "update");
  assert.equal(byPath.get("AGENTS.md"), "update");
  assert.equal(byPath.get(PUBLICATION_REHEARSAL_WORKFLOW_PATH), "update");
});

test("stale generated configuration fails closed", () => {
  const cwd = tempDir("stale");
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ name: "stale", version: "0.1.0" })}\n`,
  );
  initBuildchainRepo({ cwd, type: "package", packageManager: "pnpm" });
  const configPath = path.join(cwd, ".buildchain", "buildchain.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace(
        RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT,
        "Hosted runners define release semantics.",
      ),
  );
  assert.throws(
    () => assertPublicationRehearsalConfig(loadBuildchainConfig(cwd).config),
    /publication_rehearsal\.invariant is stale or unsupported/u,
  );
});
