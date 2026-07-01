#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXACT_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readPackageJson(cwd) {
  const filePath = path.join(cwd, "package.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`package.json not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readArg(argv, name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return argv[index + 1] || "";
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function runCommand({ cwd, cmd, args }) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed\n${result.stdout || ""}${result.stderr || ""}`.trim());
  }
  return {
    command: [cmd, ...args],
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parsePackResult(stdout) {
  const parsed = JSON.parse(stdout);
  const pack = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = Array.isArray(pack?.files) ? pack.files : [];
  const bin = files.find((file) => file.path === "bin/buildchain.mjs");
  return {
    filename: pack?.filename || "",
    name: pack?.name || "",
    version: pack?.version || "",
    size: pack?.size || 0,
    unpackedSize: pack?.unpackedSize || 0,
    entryCount: pack?.entryCount || files.length,
    bundled: pack?.bundled || [],
    binMode: bin?.mode,
  };
}

function writeGitHubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  fs.appendFileSync(outputPath, Object.entries(outputs)
    .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`)
    .join("\n") + "\n");
}

export function npmPublishDryRun({
  cwd = process.cwd(),
  expectedTag = "",
  registry = "https://registry.npmjs.org/",
  distTag = "",
  skipNpmPublishDryRun = false,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const pkg = readPackageJson(resolvedCwd);
  if (pkg.private === true) {
    throw new Error("package.json private must be false before npm publish");
  }
  if (!pkg.name || typeof pkg.name !== "string") {
    throw new Error("package.json name must be a non-empty string");
  }
  if (!pkg.version || typeof pkg.version !== "string") {
    throw new Error("package.json version must be a non-empty string");
  }
  const exactTag = `v${pkg.version}`;
  if (!EXACT_TAG_PATTERN.test(exactTag)) {
    throw new Error(`unsupported release tag for npm publish: ${exactTag}`);
  }
  if (expectedTag && expectedTag !== exactTag) {
    throw new Error(`npm publish tag must match package.json version: tag=${expectedTag} expected=${exactTag}`);
  }
  const resolvedDistTag = distTag || (pkg.version.includes("-") ? "alpha" : "latest");
  const packCommand = runCommand({
    cwd: resolvedCwd,
    cmd: "npm",
    args: ["pack", "--dry-run", "--json", `--registry=${registry}`],
  });
  const pack = parsePackResult(packCommand.stdout);
  let publishCommand;
  if (!skipNpmPublishDryRun) {
    publishCommand = runCommand({
      cwd: resolvedCwd,
      cmd: "npm",
      args: ["publish", "--dry-run", "--access", "public", "--tag", resolvedDistTag, `--registry=${registry}`],
    });
  }
  const result = {
    schemaVersion: 1,
    dryRun: true,
    wouldPublish: !skipNpmPublishDryRun,
    package: {
      name: pkg.name,
      version: pkg.version,
      private: pkg.private === true,
    },
    exactTag,
    distTag: resolvedDistTag,
    registry,
    pack,
    commands: {
      pack: packCommand.command,
      publishDryRun: publishCommand?.command || [],
    },
  };
  writeGitHubOutputs({
    version: pkg.version,
    "exact-tag": exactTag,
    "dist-tag": resolvedDistTag,
    registry,
    "pack-entry-count": pack.entryCount,
    "publish-dry-run": String(!skipNpmPublishDryRun),
  });
  return result;
}

function usage() {
  return `Usage:
  node scripts/npm-publish-dry-run.mjs [--cwd <dir>] [--expected-tag <tag>]
                                      [--registry <url>] [--dist-tag <tag>]
                                      [--skip-npm-publish-dry-run] [--json]
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, "help") || hasFlag(argv, "h")) {
      process.stdout.write(usage());
      process.exit(0);
    }
    const result = npmPublishDryRun({
      cwd: readArg(argv, "cwd", process.cwd()),
      expectedTag: readArg(argv, "expected-tag", ""),
      registry: readArg(argv, "registry", "https://registry.npmjs.org/"),
      distTag: readArg(argv, "dist-tag", ""),
      skipNpmPublishDryRun: hasFlag(argv, "skip-npm-publish-dry-run"),
    });
    if (hasFlag(argv, "json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`npm publish dry-run ok: ${result.package.name}@${result.package.version} -> ${result.distTag}\n`);
      process.stdout.write(`pack entries: ${result.pack.entryCount}\n`);
    }
  } catch (error) {
    console.error(`npm-publish-dry-run: ${error.message}`);
    process.exitCode = 1;
  }
}
