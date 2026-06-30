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
  artifactName = "buildchain-artifact",
  platformId = os.platform(),
  platformName = platformId,
  artifactPaths = [],
  workspace = process.cwd(),
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedManifestPath = path.resolve(resolvedWorkspace, manifestPath);
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
  const manifest = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact",
    artifactName,
    platform: {
      id: platformId,
      name: platformName,
      os: process.env.RUNNER_OS || os.platform(),
      arch: process.env.RUNNER_ARCH || os.arch(),
    },
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
    files: files.map((file) => {
      const stat = fs.statSync(file);
      return {
        path: manifestPathFor(resolvedWorkspace, file),
        size: stat.size,
        sha256: sha256File(file),
      };
    }),
  };

  fs.writeFileSync(resolvedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`buildchain_manifest=${path.relative(resolvedWorkspace, resolvedManifestPath)}`);
  return manifest;
}

export function normalizeCommandStage(commandText) {
  return normalizeLifecycleStage({ command: commandText }, "workflow command");
}
