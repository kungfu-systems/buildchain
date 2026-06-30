import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadBuildchainConfig,
  normalizeLifecycleStage,
  runLifecycleStage,
} from "../packages/core/buildchain-config.js";
import {
  createArtifactSummary,
  parseExpectedArtifactsJson,
  validateExpectedArtifacts,
} from "./build-contract-core.mjs";

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function listFiles(root, rel) {
  const target = path.isAbsolute(rel) ? rel : path.join(root, rel);
  if (!fs.existsSync(target)) {
    return [];
  }
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return [target];
  }
  return fs
    .readdirSync(target, { withFileTypes: true })
    .flatMap((entry) => listFiles(root, path.join(target, entry.name)));
}

function manifestPathFor(root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return toPosix(relative);
  }
  return toPosix(path.resolve(filePath));
}

function collectArtifactFiles(root, patterns) {
  const files = new Set();
  for (const pattern of patterns) {
    const clean = pattern.replace(/\\/g, "/").replace(/\/\*\*\/?\*?$/, "");
    for (const file of listFiles(root, clean)) {
      files.add(path.resolve(file));
    }
  }
  return [...files].sort();
}

export function runLifecycle({
  cwd = process.cwd(),
  stageName = "",
  command = "",
  required = false,
  manifestPath = ".buildchain/artifacts/manifest.json",
  summaryPath = ".buildchain/artifacts/summary.json",
  artifactName = "buildchain-artifact",
  platformId = os.platform(),
  platformName = platformId,
  artifactPaths = [],
  expectedArtifactsJson = "",
  workspace = process.cwd(),
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedManifestPath = path.resolve(resolvedWorkspace, manifestPath);
  const resolvedSummaryPath = path.resolve(resolvedWorkspace, summaryPath);
  const loadedConfig = loadBuildchainConfig(resolvedCwd);
  let commandSource = "none";
  let executed = false;

  if (command.trim()) {
    commandSource = "workflow-input";
    execSync(command, {
      cwd: resolvedCwd,
      env: process.env,
      shell: true,
      stdio: "inherit",
    });
    executed = true;
  } else if (stageName) {
    commandSource = "buildchain.toml";
    executed = runLifecycleStage({
      cwd: resolvedCwd,
      loadedConfig,
      name: stageName,
    });
  }

  if (required && !executed) {
    throw new Error(`required lifecycle stage did not run: ${stageName || "command"}`);
  }

  fs.mkdirSync(path.dirname(resolvedManifestPath), { recursive: true });
  const files = collectArtifactFiles(resolvedWorkspace, artifactPaths);
  const manifestFiles = files.map((file) => {
    const stat = fs.statSync(file);
    return {
      path: manifestPathFor(resolvedWorkspace, file),
      size: stat.size,
      sha256: sha256File(file),
    };
  });
  const platform = {
    id: platformId,
    name: platformName,
    os: process.env.RUNNER_OS || os.platform(),
    arch: process.env.RUNNER_ARCH || os.arch(),
  };
  const summary = createArtifactSummary({
    artifactName,
    platform,
    files: manifestFiles,
  });
  const expected = parseExpectedArtifactsJson(expectedArtifactsJson);
  const expectedArtifacts = validateExpectedArtifacts({
    expected,
    files: manifestFiles,
    summary,
  });
  const manifest = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact",
    artifactName,
    platform,
    git: {
      repository: process.env.GITHUB_REPOSITORY || "",
      sha: process.env.GITHUB_SHA || "",
      ref: process.env.GITHUB_REF || "",
      runId: process.env.GITHUB_RUN_ID || "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
    },
    lifecycle: {
      stage: stageName,
      commandSource,
      executed,
    },
    summary,
    expectedArtifacts,
    files: manifestFiles,
  };

  fs.writeFileSync(resolvedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.mkdirSync(path.dirname(resolvedSummaryPath), { recursive: true });
  fs.writeFileSync(resolvedSummaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`buildchain_manifest=${path.relative(resolvedWorkspace, resolvedManifestPath)}`);
  return manifest;
}

export function normalizeCommandStage(commandText) {
  return normalizeLifecycleStage({ command: commandText }, "workflow command");
}
