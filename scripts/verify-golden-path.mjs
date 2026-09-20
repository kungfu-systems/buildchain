#!/usr/bin/env node
import fs from "node:fs";
import { readNpmPackResult } from "../packages/core/publication/npm/pack-result.js";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncCommand } from "../packages/core/runtime/spawn-command.js";

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
    const tarball = path.join(
      packDir,
      readNpmPackResult(JSON.stringify(packed)).filename,
    );
    fs.writeFileSync(
      path.join(consumer, "package.json"),
      `${JSON.stringify(
        {
          name: "buildchain-golden-path-consumer",
          version: "0.1.0",
          private: true,
          scripts: {
            build:
              "node -e \"require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.js','export const value = 1;')\"",
            check:
              "node -e \"require('assert').ok(require('fs').statSync('dist/index.js').size > 0)\"",
          },
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
      path.join(consumer, ".github", "workflows", "buildchain.yml"),
      "utf8",
    );
    run("git", ["init", "-q"], { cwd: consumer });
    const doctor = run(buildchain, ["doctor", "--json"], {
      cwd: consumer,
      json: true,
    });
    run("npm", ["run", "build"], { cwd: consumer });
    run("npm", ["run", "check"], { cwd: consumer });
    const recovery = fs.readFileSync(
      path.join(consumer, ".github/workflows/buildchain-recover.yml"),
      "utf8",
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
      /uses:\s+kungfu-systems\/buildchain\/\.github\/workflows\/public-ops-pipeline\.yml@v4/.test(
        workflow,
      ),
      "Golden Path workflow is not a thin v4 reusable-workflow caller",
    );
    assert(
      !/\n\s+(?:inputs|with|steps):/.test(workflow),
      "Golden Path ordinary caller must have zero inputs and delegate its steps",
    );
    assert(doctor.ok, "Golden Path doctor rejected the initialized consumer");
    assert(
      validation.config.schema === 2 && validation.products[0].type === "npm",
      "Golden Path did not validate the schema-2 product",
    );
    assert(
      /public-ops-recover\.yml@v4/.test(recovery),
      "Golden Path recovery entry is not the shared caller",
    );
    assert(
      Object.keys(validation.consumer || {}).length > 0,
      "Golden Path validation did not inspect caller wiring",
    );
    return {
      contract: "kungfu-buildchain-golden-path-verification/v1",
      ok: true,
      version,
      projectType: initialized.type,
      validationPath: validation.config?.path,
      reusableWorkflows: validation.consumer.workflows,
      productBuildAndVerification: true,
      doctor: doctor.ok,
      providerEffects: false,
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
