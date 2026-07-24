#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  INPUT_CONTRACT,
  assertContainedSymlinks,
  assertRealPathInside,
  requireRepository,
  requireSha,
  resolveInside,
  sha256File,
} from "../actions/macos-credential-island/lib.js";

function env(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw (
      result.error ||
      new Error(
        `${path.basename(command)} failed with status ${result.status}: ${(result.stderr || result.stdout || "").trim().slice(0, 1200)}`,
      )
    );
  }
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function plistValue(appPath, key) {
  return run("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    path.join(appPath, "Contents", "Info.plist"),
  ]);
}

export function sealMacosCredentialInput() {
  if (process.platform !== "darwin")
    throw new Error("credential input sealing requires macOS");
  const workspace = path.resolve(process.cwd());
  const appPath = resolveInside(
    workspace,
    env("BUILDCHAIN_CREDENTIAL_ISLAND_APP_PATH"),
    "credential island app path",
  );
  if (!fs.statSync(appPath).isDirectory() || !appPath.endsWith(".app")) {
    throw new Error("credential island app path must name one .app directory");
  }
  assertRealPathInside(workspace, appPath, "credential island app path");
  assertContainedSymlinks(appPath);
  const repository = requireRepository(env("BUILDCHAIN_SOURCE_REPOSITORY"));
  const sourceSha = requireSha(env("BUILDCHAIN_SOURCE_SHA"), "source SHA");
  const treeSha = requireSha(
    env("BUILDCHAIN_SOURCE_TREE_SHA"),
    "source tree SHA",
  );
  const platformId = env("BUILDCHAIN_PLATFORM_ID");
  const arch = process.arch;
  if (!["arm64", "x64"].includes(arch))
    throw new Error(`unsupported macOS architecture: ${arch}`);
  const outputRoot = path.resolve(env("BUILDCHAIN_CREDENTIAL_ISLAND_OUTPUT"));
  const relativeOutput = path.relative(workspace, outputRoot);
  if (
    !relativeOutput ||
    relativeOutput.startsWith("..") ||
    path.isAbsolute(relativeOutput)
  ) {
    throw new Error(
      "credential island output must stay inside the build workspace",
    );
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  const archivePath = path.join(outputRoot, "unsigned-app.zip");
  run("/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appPath,
    archivePath,
  ]);
  const archive = {
    file: path.basename(archivePath),
    format: "ditto-zip",
    bytes: fs.statSync(archivePath).size,
    sha256: sha256File(archivePath),
  };
  const manifest = {
    schema: INPUT_CONTRACT,
    sealedAt: new Date().toISOString(),
    source: { repository, sha: sourceSha, treeSha },
    platform: { id: platformId, os: "macos", arch },
    app: {
      archivePath: path.basename(appPath),
      bundleId: plistValue(appPath, "CFBundleIdentifier"),
      productName: plistValue(appPath, "CFBundleName"),
      version: plistValue(appPath, "CFBundleShortVersionString"),
      buildVersion: plistValue(appPath, "CFBundleVersion"),
    },
    archive,
  };
  const manifestPath = path.join(outputRoot, "credential-input.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ manifestPath, archivePath, archive })}\n`,
  );
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    sealMacosCredentialInput();
  } catch (error) {
    console.error(
      `::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`,
    );
    process.exitCode = 1;
  }
}
