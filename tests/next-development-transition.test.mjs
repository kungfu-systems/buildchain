import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { loadBuildchainConfig } from "../packages/core/buildchain-config.js";
import {
  NEXT_DEVELOPMENT_AGENT_SECTION_START,
  assertNextDevelopmentConfig,
  nextDevelopmentManual,
} from "../packages/core/next-development-projection.js";
import {
  NEXT_DEVELOPMENT_REQUEST_CONTRACT,
  NEXT_DEVELOPMENT_STATES,
  NEXT_DEVELOPMENT_INVARIANT,
  NEXT_DEVELOPMENT_TRANSITION_CONTRACT,
  advanceNextDevelopmentTransition,
  createNextDevelopmentTransition,
  materializeNextDevelopmentTransition,
  validateNextDevelopmentTransition,
} from "../packages/core/next-development-transition.js";
import { paperAgentEntryFiles } from "../packages/core/paper-agent-entry.js";
import { initBuildchainRepo } from "../scripts/init-repo.mjs";
import { generateNextDevelopmentGuidance } from "../scripts/generate-next-development-guidance.mjs";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;
const repositoryRoot = path.resolve(import.meta.dirname, "..");

function tempDir(name) {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), `buildchain-next-development-${name}-`),
  );
}

function completedAlpha(overrides = {}) {
  return {
    outcome: "succeeded",
    version: "1.4.2-alpha.7",
    exactTag: "v1.4.2-alpha.7",
    releaseSha: "1".repeat(40),
    treeSha: "2".repeat(40),
    publicationRoot: ROOT("3"),
    completedAt: "2026-08-11T01:00:00.000Z",
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    contract: NEXT_DEVELOPMENT_REQUEST_CONTRACT,
    repository: "example/widget",
    completedAlpha: completedAlpha(),
    recordedAt: "2026-08-11T01:01:00.000Z",
    ...overrides,
  };
}

function writeSemverCheckout(cwd) {
  fs.mkdirSync(path.join(cwd, ".buildchain"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain", "buildchain.toml"),
    `schema = 1

[version]
required = true
strategy = "semver"
next = "auto"

[[version.files]]
type = "json"
path = "package.json"
key = "version"
`,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ name: "widget", version: "1.4.2-alpha.7" }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(cwd, "outside.txt"), "untouched\n");
}

function digestFile(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

test("schemas and rooted fixtures admit both legal models", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        "contracts/next-development-transition-v1.schema.json",
      ),
      "utf8",
    ),
  );
  const validate = ajv.compile(schema);
  for (const fixture of [
    "semver-auto-planned.json",
    "anchored-manual-waiting.json",
  ]) {
    const value = JSON.parse(
      fs.readFileSync(
        path.join(
          repositoryRoot,
          "contracts/fixtures/next-development-transition-v1",
          fixture,
        ),
        "utf8",
      ),
    );
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.deepEqual(validateNextDevelopmentTransition(value), value);
  }
});

test("positive and negative fixtures freeze the only legal version strategies", () => {
  const cases = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        "contracts/fixtures/next-development-transition-v1/version-model-cases.json",
      ),
      "utf8",
    ),
  );
  for (const fixture of cases.positive) {
    assert.doesNotThrow(() =>
      createNextDevelopmentTransition({
        repository: "example/widget",
        completedAlpha: completedAlpha(),
        model: fixture.model,
        sourcePaths: ["package.json"],
        readOnlyPaths:
          fixture.model.strategy === "anchored" ? ["release.json"] : [],
      }),
    );
  }
  for (const fixture of cases.negative) {
    assert.throws(
      () =>
        createNextDevelopmentTransition({
          repository: "example/widget",
          completedAlpha: completedAlpha(),
          model: fixture.model,
          sourcePaths: ["package.json"],
          readOnlyPaths: fixture.anchor ? ["release.json"] : [],
          targetVersion: fixture.targetVersion,
          anchor: fixture.anchor,
        }),
      new RegExp(fixture.error.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  }
});

test("completed Alpha success and the idempotency key survive every next-development state", () => {
  const cwd = tempDir("states");
  writeSemverCheckout(cwd);
  let record = materializeNextDevelopmentTransition({
    cwd,
    request: request(),
    write: true,
  });
  assert.deepEqual(NEXT_DEVELOPMENT_STATES, [
    "planned",
    "waiting-anchor",
    "materialized",
    "pr-pending",
    "merged",
    "verified",
  ]);
  const idempotencyKey = record.idempotencyKey;
  const commands = [
    [
      "pr-pending",
      "protected-version-pr-opened",
      ROOT("4"),
      "2026-08-11T01:02:00.000Z",
    ],
    [
      "merged",
      "protected-version-pr-merged",
      ROOT("5"),
      "2026-08-11T01:03:00.000Z",
    ],
    [
      "verified",
      "next-development-verified",
      ROOT("6"),
      "2026-08-11T01:04:00.000Z",
    ],
  ];
  let replayCommand;
  for (const [to, event, evidenceRoot, recordedAt] of commands) {
    const command = {
      to,
      event,
      evidenceRoot,
      recordedAt,
      expectedStateRoot: record.state.stateRoot,
    };
    record = advanceNextDevelopmentTransition(record, command);
    replayCommand ||= command;
    assert.equal(record.alphaOutcome, "preserved-success");
    assert.equal(record.completedAlpha.outcome, "succeeded");
    assert.equal(record.idempotencyKey, idempotencyKey);
    assert.deepEqual(record.effectBounds.refUpdates, []);
  }
  assert.equal(record.state.status, "verified");
  assert.deepEqual(
    advanceNextDevelopmentTransition(record, replayCommand),
    record,
  );
  assert.throws(
    () =>
      validateNextDevelopmentTransition({
        ...record,
        effectBounds: {
          ...record.effectBounds,
          refUpdates: ["refs/heads/alpha/v1/v1.4"],
        },
      }),
    /effect bounds drifted/u,
  );
});

test("local semver adapter is dry-run by default, write-bounded, runnable, and idempotent", () => {
  const cwd = tempDir("semver");
  writeSemverCheckout(cwd);
  const before = fs.readFileSync(path.join(cwd, "package.json"), "utf8");
  const dryRun = materializeNextDevelopmentTransition({
    cwd,
    request: request(),
  });
  assert.equal(dryRun.target.version, "1.4.2-alpha.8");
  assert.equal(dryRun.state.status, "planned");
  assert.deepEqual(dryRun.adapter, {
    environmentVariable: "BUILDCHAIN_VERSION",
    sourcePaths: ["package.json"],
    derivedPaths: [],
    allowedChangePaths: ["package.json"],
    readOnlyPaths: [],
    derivationStage: null,
    verificationStage: "lifecycle.verify",
  });
  assert.equal(fs.readFileSync(path.join(cwd, "package.json"), "utf8"), before);
  assert.equal(
    fs.readFileSync(path.join(cwd, "outside.txt"), "utf8"),
    "untouched\n",
  );

  const written = materializeNextDevelopmentTransition({
    cwd,
    request: request(),
    write: true,
  });
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
  );
  assert.equal(packageJson.version, "1.4.2-alpha.8");
  assert.equal(written.state.status, "materialized");
  assert.equal(written.idempotencyKey, dryRun.idempotencyKey);
  const writtenBytes = fs.readFileSync(path.join(cwd, "package.json"), "utf8");
  const replay = materializeNextDevelopmentTransition({
    cwd,
    request: request(),
    write: true,
  });
  assert.equal(
    fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
    writtenBytes,
  );
  assert.equal(replay.idempotencyKey, written.idempotencyKey);
  assert.equal(
    fs.readFileSync(path.join(cwd, "outside.txt"), "utf8"),
    "untouched\n",
  );

  const inputPath = path.join(cwd, "request.json");
  fs.writeFileSync(inputPath, `${JSON.stringify(request())}\n`);
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(repositoryRoot, "scripts/next-development-transition.mjs"),
        "materialize",
        "--cwd",
        cwd,
        "--input",
        inputPath,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(output.idempotencyKey, written.idempotencyKey);
});

test("adapter validates the request timestamp before any declared-path write", () => {
  const cwd = tempDir("invalid-timestamp");
  writeSemverCheckout(cwd);
  const before = fs.readFileSync(path.join(cwd, "package.json"), "utf8");
  assert.throws(
    () =>
      materializeNextDevelopmentTransition({
        cwd,
        request: request({ recordedAt: "not-a-timestamp" }),
        write: true,
      }),
    /recordedAt must be a canonical ISO-8601 timestamp/u,
  );
  assert.equal(fs.readFileSync(path.join(cwd, "package.json"), "utf8"), before);
});

test("derived paths are contract-bound and the reference writer fails closed", () => {
  const cwd = tempDir("derived");
  fs.mkdirSync(path.join(cwd, ".buildchain"), { recursive: true });
  const configPath = path.join(cwd, ".buildchain", "buildchain.toml");
  fs.writeFileSync(
    configPath,
    `schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "release.json"
derived_files = ["dist/version.json"]

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.version-state]
command = "node derive.mjs"

[lifecycle.verify]
command = "node verify.mjs"
`,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    '{"name":"widget","version":"1.4.2-alpha.7"}\n',
  );
  fs.writeFileSync(path.join(cwd, "release.json"), '{"upstream":"v22"}\n');
  fs.mkdirSync(path.join(cwd, "dist"));
  fs.writeFileSync(path.join(cwd, "dist", "version.json"), '{"ok":true}\n');
  const before = fs.readFileSync(path.join(cwd, "package.json"), "utf8");
  const anchoredRequest = request({
    targetVersion: "22.1.0",
    anchor: {
      manifestPath: "release.json",
      manifestRoot: digestFile(path.join(cwd, "release.json")),
    },
  });
  const plan = materializeNextDevelopmentTransition({
    cwd,
    request: anchoredRequest,
  });
  assert.deepEqual(plan.adapter, {
    environmentVariable: "BUILDCHAIN_VERSION",
    sourcePaths: ["package.json"],
    derivedPaths: ["dist/version.json"],
    allowedChangePaths: ["dist/version.json", "package.json"],
    readOnlyPaths: ["release.json"],
    derivationStage: "lifecycle.version-state",
    verificationStage: "lifecycle.verify",
  });
  assert.throws(
    () =>
      materializeNextDevelopmentTransition({
        cwd,
        request: anchoredRequest,
        write: true,
      }),
    /transaction adapter must run lifecycle\.version-state/u,
  );
  assert.equal(fs.readFileSync(path.join(cwd, "package.json"), "utf8"), before);
});

test("anchored/manual waits without authority and verifies the declared manifest before writing", () => {
  const cwd = tempDir("anchored");
  fs.mkdirSync(path.join(cwd, ".buildchain"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain", "buildchain.toml"),
    `schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"
`,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    '{"name":"widget","version":"1.4.2-alpha.7"}\n',
  );
  fs.writeFileSync(path.join(cwd, "release.json"), '{"upstream":"v22.1.0"}\n');
  const waiting = materializeNextDevelopmentTransition({
    cwd,
    request: request(),
  });
  assert.equal(waiting.state.status, "waiting-anchor");
  assert.equal(waiting.completedAlpha.outcome, "succeeded");

  const anchoredRequest = request({
    targetVersion: "22.1.0",
    anchor: {
      manifestPath: "release.json",
      manifestRoot: digestFile(path.join(cwd, "release.json")),
    },
  });
  const materialized = materializeNextDevelopmentTransition({
    cwd,
    request: anchoredRequest,
    write: true,
  });
  assert.equal(materialized.state.status, "materialized");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version,
    "22.1.0",
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "release.json"), "utf8"),
    '{"upstream":"v22.1.0"}\n',
  );
  assert.equal(materialized.idempotencyKey, waiting.idempotencyKey);
  assert.throws(
    () =>
      materializeNextDevelopmentTransition({
        cwd,
        request: request({
          targetVersion: "22.1.1",
          anchor: { manifestPath: "release.json", manifestRoot: ROOT("9") },
        }),
      }),
    /manifest root does not match/u,
  );
});

test("adapter rejects symlinked declared files instead of escaping its side-effect boundary", () => {
  const cwd = tempDir("symlink");
  writeSemverCheckout(cwd);
  const external = path.join(tempDir("external"), "package.json");
  fs.writeFileSync(external, '{"version":"1.4.2-alpha.7"}\n');
  fs.unlinkSync(path.join(cwd, "package.json"));
  fs.symlinkSync(external, path.join(cwd, "package.json"));
  assert.throws(
    () =>
      materializeNextDevelopmentTransition({
        cwd,
        request: request(),
        write: true,
      }),
    /regular non-symlink file/u,
  );
  assert.equal(
    fs.readFileSync(external, "utf8"),
    '{"version":"1.4.2-alpha.7"}\n',
  );
});

test("fresh templates, Paper Agent guidance, and generated manual share one contract source", () => {
  for (const type of ["package", "anchored-package"]) {
    const cwd = tempDir(`init-${type}`);
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      '{"name":"widget","version":"0.1.0"}\n',
    );
    initBuildchainRepo({ cwd, type, packageManager: "pnpm" });
    assert.doesNotThrow(() =>
      assertNextDevelopmentConfig(loadBuildchainConfig(cwd).config),
    );
    assert.match(
      fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8"),
      new RegExp(NEXT_DEVELOPMENT_AGENT_SECTION_START),
    );
    const workflow = fs.readFileSync(
      path.join(cwd, ".github", "workflows", "build.yml"),
      "utf8",
    );
    assert.match(workflow, new RegExp(NEXT_DEVELOPMENT_TRANSITION_CONTRACT));
    assert.match(workflow, new RegExp(NEXT_DEVELOPMENT_INVARIANT));
  }
  const paper = tempDir("paper-agent");
  const files = paperAgentEntryFiles({
    cwd: paper,
    buildchainVersion: "3.0.9-alpha.1",
    buildchainSha: "a".repeat(40),
    developmentRef: "dev/v3/v3.0",
  });
  assert.match(
    files.get("AGENTS.md"),
    new RegExp(NEXT_DEVELOPMENT_AGENT_SECTION_START),
  );
  assert.equal(
    fs.readFileSync(
      path.join(repositoryRoot, "docs/next-development-transition.md"),
      "utf8",
    ),
    nextDevelopmentManual(),
  );
});

test("generated guidance check fails when the projection diverges", () => {
  const cwd = tempDir("guidance-drift");
  assert.throws(
    () => generateNextDevelopmentGuidance({ cwd, check: true }),
    /drifted from its contract source/u,
  );
  generateNextDevelopmentGuidance({ cwd });
  assert.deepEqual(generateNextDevelopmentGuidance({ cwd, check: true }), {
    ok: true,
    changed: false,
    path: "docs/next-development-transition.md",
  });
  fs.appendFileSync(
    path.join(cwd, "docs/next-development-transition.md"),
    "drift\n",
  );
  assert.throws(
    () => generateNextDevelopmentGuidance({ cwd, check: true }),
    /drifted from its contract source/u,
  );
});
