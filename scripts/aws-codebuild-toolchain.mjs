#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const AWS_CODEBUILD_TOOLCHAIN = Object.freeze({
  schema: "buildchain.aws-codebuild-native-toolchain/v1",
  gccPackages: ["gcc14", "gcc14-c++"],
  gcc: "gcc14-gcc",
  gxx: "gcc14-g++",
  cmakeVersion: "3.31.6",
  cmakeArchive: "cmake-3.31.6-linux-x86_64.tar.gz",
  cmakeSha256:
    "5a1133ff103c71eb5120e2cc3de922733e7d8a26a98ae716397e8676adb367bf",
  cmakeBaseUrl: "https://github.com/Kitware/CMake/releases/download/v3.31.6",
});

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    ...options,
  });
}

function commandPath(command) {
  return run("bash", ["-lc", `command -v ${command}`], {
    capture: true,
  }).trim();
}

function appendGitHubPath(entry) {
  const githubPath = process.env.GITHUB_PATH;
  if (!githubPath) {
    throw new Error("GITHUB_PATH is required on the CodeBuild GitHub runner");
  }
  fs.appendFileSync(githubPath, `${entry}\n`);
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function ensureAlias(directory, name, target) {
  const alias = path.join(directory, name);
  if (fs.existsSync(alias)) {
    if (fs.realpathSync(alias) !== fs.realpathSync(target)) {
      throw new Error(`${alias} already exists with a different target`);
    }
    return alias;
  }
  fs.symlinkSync(target, alias);
  return alias;
}

function assertMinimumVersion(output, minimum, label) {
  const match = String(output).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) throw new Error(`${label} did not report a parseable version`);
  const actual = match.slice(1, 4).map((value) => Number(value || 0));
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] > required[index]) return;
    if (actual[index] < required[index]) {
      throw new Error(`${label} ${actual.join(".")} is below ${minimum}`);
    }
  }
}

function writeEvidence(outputPath, evidence) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

export function prepareAwsCodeBuildToolchain({
  runnerTemp = process.env.RUNNER_TEMP || os.tmpdir(),
  evidencePath = process.env.BUILDCHAIN_BURST_TOOLCHAIN_EVIDENCE_PATH ||
    ".buildchain/artifacts/linux-x64/aws-native-toolchain.json",
} = {}) {
  if (!process.env.CODEBUILD_BUILD_ID) {
    throw new Error(
      "AWS CodeBuild toolchain preparation requires CODEBUILD_BUILD_ID",
    );
  }
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("AWS CodeBuild toolchain preparation requires Linux x64");
  }

  const elevated =
    typeof process.getuid === "function" && process.getuid() === 0;
  const installCommand = elevated ? "dnf" : "sudo";
  const installArgs = elevated
    ? ["install", "-y", ...AWS_CODEBUILD_TOOLCHAIN.gccPackages]
    : ["dnf", "install", "-y", ...AWS_CODEBUILD_TOOLCHAIN.gccPackages];
  run(installCommand, installArgs);

  const aliasDirectory = path.join(runnerTemp, "buildchain-gcc14", "bin");
  fs.mkdirSync(aliasDirectory, { recursive: true });
  const gccPath = commandPath(AWS_CODEBUILD_TOOLCHAIN.gcc);
  const gxxPath = commandPath(AWS_CODEBUILD_TOOLCHAIN.gxx);
  ensureAlias(aliasDirectory, "cc", gccPath);
  ensureAlias(aliasDirectory, "gcc", gccPath);
  ensureAlias(aliasDirectory, "c++", gxxPath);
  ensureAlias(aliasDirectory, "g++", gxxPath);

  const cmakeUrl = `${AWS_CODEBUILD_TOOLCHAIN.cmakeBaseUrl}/${AWS_CODEBUILD_TOOLCHAIN.cmakeArchive}`;
  const cmakeArchivePath = path.join(
    runnerTemp,
    AWS_CODEBUILD_TOOLCHAIN.cmakeArchive,
  );
  run("curl", [
    "--proto",
    "=https",
    "--tlsv1.2",
    "--fail",
    "--location",
    "--retry",
    "5",
    "--retry-all-errors",
    "--output",
    cmakeArchivePath,
    cmakeUrl,
  ]);
  const actualCmakeSha256 = sha256(cmakeArchivePath);
  if (actualCmakeSha256 !== AWS_CODEBUILD_TOOLCHAIN.cmakeSha256) {
    throw new Error(
      `CMake archive SHA256 ${actualCmakeSha256} does not match the reviewed pin`,
    );
  }

  const cmakeDirectory = path.join(
    runnerTemp,
    `buildchain-cmake-${AWS_CODEBUILD_TOOLCHAIN.cmakeVersion}`,
  );
  fs.mkdirSync(cmakeDirectory, { recursive: true });
  run("tar", [
    "-xzf",
    cmakeArchivePath,
    "-C",
    cmakeDirectory,
    "--strip-components=1",
  ]);
  const cmakeBinDirectory = path.join(cmakeDirectory, "bin");
  const cmakePath = path.join(cmakeBinDirectory, "cmake");

  const gccVersion = run(gccPath, ["--version"], { capture: true }).trim();
  const gxxVersion = run(gxxPath, ["--version"], { capture: true }).trim();
  const cmakeVersion = run(cmakePath, ["--version"], { capture: true }).trim();
  assertMinimumVersion(gccVersion, "14.0.0", "gcc");
  assertMinimumVersion(gxxVersion, "14.0.0", "g++");
  assertMinimumVersion(cmakeVersion, "3.28.0", "cmake");

  appendGitHubPath(aliasDirectory);
  appendGitHubPath(cmakeBinDirectory);

  const evidence = {
    schema: AWS_CODEBUILD_TOOLCHAIN.schema,
    provider: "aws-codebuild",
    buildId: process.env.CODEBUILD_BUILD_ID,
    os: process.platform,
    architecture: process.arch,
    gcc: {
      packages: AWS_CODEBUILD_TOOLCHAIN.gccPackages,
      executable: AWS_CODEBUILD_TOOLCHAIN.gcc,
      version: gccVersion.split("\n")[0],
    },
    gxx: {
      executable: AWS_CODEBUILD_TOOLCHAIN.gxx,
      version: gxxVersion.split("\n")[0],
    },
    cmake: {
      version: cmakeVersion.split("\n")[0],
      source: cmakeUrl,
      sha256: actualCmakeSha256,
    },
    observedAt: new Date().toISOString(),
  };
  writeEvidence(path.resolve(evidencePath), evidence);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

export function main() {
  const mode = process.argv[2] || "plan";
  if (mode === "plan") {
    process.stdout.write(
      `${JSON.stringify(AWS_CODEBUILD_TOOLCHAIN, null, 2)}\n`,
    );
    return AWS_CODEBUILD_TOOLCHAIN;
  }
  if (mode === "prepare") return prepareAwsCodeBuildToolchain();
  throw new Error(`unsupported aws-codebuild-toolchain mode: ${mode}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message || error}`);
    process.exitCode = 1;
  }
}
