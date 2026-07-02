#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BUNDLE_CONTRACT = "kungfu-buildchain-release-evidence-bundle";
const BUNDLE_BASE = "buildchain-release-bundle";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || "";
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listFiles(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }
  const results = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile()) {
        results.push(entryPath);
      }
    }
  };
  walk(dir);
  return results.sort((a, b) => a.localeCompare(b));
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function relative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function isBundleOutput(filePath) {
  const name = path.basename(filePath);
  return name === `${BUNDLE_BASE}.tar.gz` || name === `${BUNDLE_BASE}.json`;
}

export function createReleaseEvidenceBundle({
  cwd = process.cwd(),
  assetsDir = "dist/binary",
  passportDir = ".buildchain/release-passport",
  outputDir = ".buildchain/release-passport",
  tag = "",
  sourceSha = "",
} = {}) {
  const resolvedAssetsDir = path.resolve(cwd, assetsDir);
  const resolvedPassportDir = path.resolve(cwd, passportDir);
  const resolvedOutputDir = path.resolve(cwd, outputDir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-release-bundle-"));
  const bundleRoot = path.join(tempDir, BUNDLE_BASE);
  const sourceSets = [
    { id: "release-assets", dir: resolvedAssetsDir, bundlePrefix: "release-assets" },
    { id: "release-passport", dir: resolvedPassportDir, bundlePrefix: "release-passport" },
  ];
  const included = [];
  for (const sourceSet of sourceSets) {
    for (const sourcePath of listFiles(sourceSet.dir)) {
      if (isBundleOutput(sourcePath)) {
        continue;
      }
      const sourceRelative = relative(sourceSet.dir, sourcePath);
      const bundlePath = path.join(bundleRoot, sourceSet.bundlePrefix, sourceRelative);
      copyFile(sourcePath, bundlePath);
      included.push({
        source: sourceSet.id,
        sourcePath: relative(cwd, sourcePath),
        bundlePath: relative(bundleRoot, bundlePath),
        size: fs.statSync(sourcePath).size,
        sha256: sha256File(sourcePath),
      });
    }
  }
  if (included.length === 0) {
    throw new Error("release evidence bundle requires at least one input file");
  }

  const index = {
    schemaVersion: 1,
    contract: BUNDLE_CONTRACT,
    release: {
      tag,
      sourceSha,
    },
    entrypoints: {
      releasePassport: "release-passport/buildchain.release.json",
      checksums: "release-assets/checksums.txt",
      agentIndex: "release-passport/agent-index.json",
      llms: "release-passport/llms.txt",
    },
    files: included,
  };
  fs.writeFileSync(path.join(bundleRoot, `${BUNDLE_BASE}.index.json`), `${JSON.stringify(index, null, 2)}\n`);

  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  const archivePath = path.join(resolvedOutputDir, `${BUNDLE_BASE}.tar.gz`);
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", tempDir, BUNDLE_BASE], {
    cwd,
    stdio: "inherit",
  });
  if (tar.error) {
    throw tar.error;
  }
  if (tar.status !== 0) {
    throw new Error(`tar exited with ${tar.status}`);
  }
  const manifest = {
    ...index,
    bundle: {
      name: path.basename(archivePath),
      path: relative(cwd, archivePath),
      size: fs.statSync(archivePath).size,
      sha256: sha256File(archivePath),
    },
  };
  const manifestPath = path.join(resolvedOutputDir, `${BUNDLE_BASE}.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    outputDir: resolvedOutputDir,
    archivePath,
    manifestPath,
    manifest,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = createReleaseEvidenceBundle({
      cwd: path.resolve(readArg("cwd", process.cwd())),
      assetsDir: readArg("assets-dir", "dist/binary"),
      passportDir: readArg("passport-dir", ".buildchain/release-passport"),
      outputDir: readArg("output-dir", ".buildchain/release-passport"),
      tag: readArg("tag", process.env.RELEASE_TAG || ""),
      sourceSha: readArg("source-sha", process.env.GITHUB_SHA || ""),
    });
    process.stdout.write(`${JSON.stringify({
      contract: BUNDLE_CONTRACT,
      archive: result.manifest.bundle,
      fileCount: result.manifest.files.length,
    }, null, 2)}\n`);
  } catch (error) {
    console.error(`buildchain release bundle: ${error.message}`);
    process.exitCode = 1;
  }
}
