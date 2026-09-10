import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  INPUT_CONTRACT,
  assertContainedSymlinks,
  assertRealPathInside,
  requireRepository,
  requireSha,
  resolveInside,
  sha256File,
} from "../macos-credential-island/lib.js";

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

export function sealMacosCredentialInput({
  workspace,
  app,
  repository: repositoryValue,
  sourceSha: shaValue,
  sourceTreeSha,
  platformId,
  outputRoot: outputValue,
}) {
  if (process.platform !== "darwin")
    throw new Error("credential input sealing requires macOS");
  const appPath = resolveInside(workspace, app, "credential island app path");
  if (!fs.statSync(appPath).isDirectory() || !appPath.endsWith(".app")) {
    throw new Error("credential island app path must name one .app directory");
  }
  assertRealPathInside(workspace, appPath, "credential island app path");
  assertContainedSymlinks(appPath);
  const repository = requireRepository(repositoryValue);
  const sourceSha = requireSha(shaValue, "source SHA");
  const treeSha = requireSha(sourceTreeSha, "source tree SHA");
  const arch = process.arch;
  if (!["arm64", "x64"].includes(arch))
    throw new Error(`unsupported macOS architecture: ${arch}`);
  const outputRoot = path.resolve(workspace, outputValue);
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
  return manifest;
}
