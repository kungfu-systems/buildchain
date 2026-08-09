#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncCommand } from "../packages/core/spawn-command.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, { cwd, json = false } = {}) {
  const result = spawnSyncCommand(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
    timeout: 10 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout || result.error?.message}`,
    );
  }
  return json ? JSON.parse(result.stdout) : result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyGoldenPath() {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-golden-path-"),
  );
  const packDir = path.join(temporary, "pack");
  const consumer = path.join(temporary, "consumer");
  fs.mkdirSync(packDir);
  fs.mkdirSync(consumer);
  try {
    const packed = run(
      "npm",
      ["pack", "--json", "--pack-destination", packDir],
      { cwd: root, json: true },
    );
    const tarball = path.join(packDir, packed[0].filename);
    fs.writeFileSync(
      path.join(consumer, "package.json"),
      `${JSON.stringify(
        {
          name: "buildchain-golden-path-consumer",
          version: "0.1.0",
          private: true,
          scripts: { build: 'node -e ""', check: 'node -e ""' },
        },
        null,
        2,
      )}\n`,
    );
    run("npm", ["install", "--ignore-scripts", "--package-lock", tarball], {
      cwd: consumer,
    });
    const buildchain = path.join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "buildchain.cmd" : "buildchain",
    );
    const version = run(buildchain, ["--version"], { cwd: consumer }).trim();
    const initialized = run(
      buildchain,
      ["init", "--type", "package", "--package-manager", "npm"],
      { cwd: consumer, json: true },
    );
    const validation = run(
      buildchain,
      [
        "validate",
        "--require-version-state",
        "--require-lifecycle-stages",
        "install,build,verify",
      ],
      { cwd: consumer, json: true },
    );
    const workflow = fs.readFileSync(
      path.join(consumer, ".github", "workflows", "build.yml"),
      "utf8",
    );
    const releaseDryRun = run(
      buildchain,
      ["release", "--dry-run", "--target-ref", "alpha/v3/v3.0", "--json"],
      { cwd: consumer, json: true },
    );
    const passportPath = path.join(
      consumer,
      ".buildchain",
      "golden-path",
      "buildchain.release.json",
    );
    fs.mkdirSync(path.dirname(passportPath), { recursive: true });
    run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import fs from "node:fs"; import { createReleasePassport } from "@kungfu-tech/buildchain"; const value=createReleasePassport({repository:"example/consumer",tag:"v0.1.0-alpha.0",sourceSha:"a".repeat(40),assets:[{name:"consumer.tgz",sha256:"b".repeat(64)}]}); fs.writeFileSync(${JSON.stringify(passportPath)}, JSON.stringify(value,null,2)+"\\n");`,
      ],
      { cwd: consumer },
    );
    const inspection = run(
      buildchain,
      ["inspect", "release", "--passport", passportPath, "--json"],
      { cwd: consumer, json: true },
    );

    assert(
      initialized.type === "package",
      "Golden Path init did not retain the package project type",
    );
    assert(
      validation.config?.path === ".buildchain/buildchain.toml",
      "Golden Path validation did not read the generated config",
    );
    assert(
      ["install", "build", "verify"].every((name) =>
        (validation.lifecycleStages || []).some((stage) => stage.name === name),
      ),
      "Golden Path validation did not retain the required lifecycle stages",
    );
    assert(
      /uses:\s+kungfu-systems\/buildchain\/.github\/workflows\/.build.yml@v3/.test(
        workflow,
      ),
      "Golden Path workflow is not a thin v3 reusable-workflow caller",
    );
    assert(
      /buildchain-ref:/.test(workflow),
      "Golden Path workflow lacks the bounded runtime override input",
    );
    assert(
      releaseDryRun && typeof releaseDryRun === "object",
      "Golden Path release dry-run did not return JSON",
    );
    assert(
      inspection && typeof inspection === "object",
      "Golden Path Release Passport inspection did not return JSON",
    );
    return {
      contract: "kungfu-buildchain-golden-path-verification/v1",
      ok: true,
      version,
      projectType: initialized.type,
      validationPath: validation.config?.path,
      reusableWorkflow: ".github/workflows/build.yml",
      releaseDryRun: true,
      releasePassportInspection: true,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  process.stdout.write(`${JSON.stringify(verifyGoldenPath(), null, 2)}\n`);
} catch (error) {
  console.error(`buildchain Golden Path: ${error.message}`);
  process.exitCode = 1;
}
