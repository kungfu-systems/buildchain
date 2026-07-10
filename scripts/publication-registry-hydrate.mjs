#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadBuildchainConfig } from "../packages/core/buildchain-config.js";

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

function semverParts(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  if (!a || !b) throw new Error(`invalid semver comparison: ${left}, ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length
      ? 0
      : a.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) - Number(bv);
    if (an !== bn) return an ? -1 : 1;
    return av.localeCompare(bv);
  }
  return 0;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function packageVersions(packageName, registry, commandRunner) {
  try {
    const output = commandRunner("npm", [
      "view",
      packageName,
      "versions",
      "--json",
      `--registry=${registry}`,
    ]);
    const parsed = JSON.parse(output || "[]");
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch (error) {
    const detail = [error?.message, error?.stderr, error?.stdout]
      .filter(Boolean)
      .join("\n");
    if (/E404|404 Not Found|is not in this registry/i.test(detail)) {
      return [];
    }
    throw error;
  }
}

export function hydratePublishedPublicationRegistry({
  cwd = process.cwd(),
  outputDir = ".buildchain/publication/registry-inputs",
  evidencePath = ".buildchain/publication/registry-hydration.json",
  registry = DEFAULT_REGISTRY,
  commandRunner = run,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const config = loadBuildchainConfig(resolvedCwd).config;
  const packageName =
    config.publish?.package || config.publish?.mainPackage || "";
  const currentVersion = config.publication?.version || "";
  const registryPath = config.publication?.archive?.registryPath || "";
  const resolvedOutputDir = path.resolve(resolvedCwd, outputDir);
  fs.rmSync(resolvedOutputDir, { recursive: true, force: true });
  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  if (!packageName || !currentVersion || !registryPath) {
    return {
      status: "not-configured",
      packageName,
      currentVersion,
      inputDir: path
        .relative(resolvedCwd, resolvedOutputDir)
        .split(path.sep)
        .join("/"),
      sources: [],
    };
  }
  const publishedVersions = packageVersions(
    packageName,
    registry,
    commandRunner,
  )
    .filter(
      (version) =>
        semverParts(version) && compareSemver(version, currentVersion) < 0,
    )
    .sort(compareSemver);
  const sources = [];
  for (const version of publishedVersions) {
    const packageDir = path.join(resolvedOutputDir, `.package-${version}`);
    fs.mkdirSync(packageDir, { recursive: true });
    const packed = JSON.parse(
      commandRunner(
        "npm",
        [
          "pack",
          `${packageName}@${version}`,
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          packageDir,
          `--registry=${registry}`,
        ],
        { cwd: resolvedCwd },
      ),
    );
    const pack = Array.isArray(packed) ? packed[0] : packed;
    if (!pack?.filename || !pack?.integrity) {
      throw new Error(
        `npm pack did not report filename and integrity for ${packageName}@${version}`,
      );
    }
    const tarball = path.resolve(packageDir, pack.filename);
    const archiveRegistryPath = `package/${registryPath}`;
    const archiveEntries = commandRunner("tar", ["-tzf", tarball]).split(/\r?\n/);
    if (!archiveEntries.includes(archiveRegistryPath)) {
      sources.push({
        package: packageName,
        version,
        integrity: pack.integrity,
        status: "registry-not-present",
      });
      continue;
    }
    const target = path.join(resolvedOutputDir, `${version}.json`);
    const registryJson = commandRunner("tar", ["-xOzf", tarball, archiveRegistryPath]);
    fs.writeFileSync(target, `${registryJson}\n`);
    sources.push({
      package: packageName,
      version,
      integrity: pack.integrity,
      status: "accepted-input",
      registryPath: path
        .relative(resolvedCwd, target)
        .split(path.sep)
        .join("/"),
    });
  }
  for (const entry of fs.readdirSync(resolvedOutputDir)) {
    if (entry.startsWith(".package-")) {
      fs.rmSync(path.join(resolvedOutputDir, entry), {
        recursive: true,
        force: true,
      });
    }
  }
  const evidence = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-publication-registry-hydration",
    status: sources.some((source) => source.status === "accepted-input")
      ? "hydrated"
      : "bootstrap",
    authentication: "npm-registry-https-plus-package-integrity",
    registry,
    packageName,
    currentVersion,
    inputDir: path
      .relative(resolvedCwd, resolvedOutputDir)
      .split(path.sep)
      .join("/"),
    sources,
  };
  const resolvedEvidencePath = path.resolve(resolvedCwd, evidencePath);
  fs.mkdirSync(path.dirname(resolvedEvidencePath), { recursive: true });
  fs.writeFileSync(
    resolvedEvidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return evidence;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const cwdIndex = process.argv.indexOf("--cwd");
    const result = hydratePublishedPublicationRegistry({
      cwd: cwdIndex === -1 ? process.cwd() : process.argv[cwdIndex + 1],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`publication-registry-hydrate: ${error.message}`);
    process.exitCode = 1;
  }
}
