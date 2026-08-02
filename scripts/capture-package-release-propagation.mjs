#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createPackageReleasePropagationCapture,
  normalizePackageReleasePropagationConfig,
} from "../packages/core/release-propagation-capture.js";
import { stableJson } from "../packages/core/release-propagation-common.js";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function required(args, key) {
  const value = String(args[key] || "").trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function commandJson(command, args, options = {}) {
  const text = execFileSync(command, args, { encoding: "utf8", ...options });
  return JSON.parse(text);
}

function assertSourcePath(value) {
  const sourcePath = String(value || "").trim();
  if (!sourcePath || path.isAbsolute(sourcePath) || sourcePath.split("/").includes("..") || /[\r\n]/.test(sourcePath)) {
    throw new Error("release propagation config path must be a safe repository-relative path");
  }
  return sourcePath;
}

function readConfigAtSource(sourceSha, configPath, cwd) {
  const bytes = execFileSync("git", ["show", `${sourceSha}:${configPath}`], {
    cwd,
    encoding: "utf8",
  });
  const parsed = JSON.parse(bytes);
  return { bytes, parsed, normalized: normalizePackageReleasePropagationConfig(parsed) };
}

function resolveTagTarget(repository, tag) {
  let object = commandJson("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`]).object;
  for (let depth = 0; depth < 8 && object?.type === "tag"; depth += 1) {
    object = commandJson("gh", ["api", `repos/${repository}/git/tags/${object.sha}`]).object;
  }
  if (object?.type !== "commit" || !/^[0-9a-f]{40}$/i.test(object.sha || "")) {
    throw new Error(`release tag ${tag} does not resolve to one exact commit`);
  }
  return object.sha.toLowerCase();
}

function resolvePackageFact(packageName, version) {
  const fact = commandJson("npm", [
    "view",
    `${packageName}@${version}`,
    "version",
    "dist.integrity",
    "gitHead",
    "--json",
    "--registry=https://registry.npmjs.org/",
  ]);
  return {
    name: packageName,
    version: String(fact.version || ""),
    integrity: String(fact.dist?.integrity || fact["dist.integrity"] || ""),
    gitHead: String(fact.gitHead || "").toLowerCase(),
  };
}

function verifyPublicReleasePassport({ repository, tag, localPath }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-release-passport-"));
  try {
    execFileSync("gh", [
      "release", "download", tag,
      "--repo", repository,
      "--pattern", "buildchain.release.json",
      "--dir", temporary,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const localBytes = fs.readFileSync(localPath);
    const remotePath = path.join(temporary, "buildchain.release.json");
    const remoteBytes = fs.readFileSync(remotePath);
    const localDigest = sha256(localBytes);
    const remoteDigest = sha256(remoteBytes);
    if (localDigest !== remoteDigest) {
      throw new Error("public release passport bytes disagree with finalized local passport");
    }
    return {
      url: `https://github.com/${repository}/releases/download/${tag}/buildchain.release.json`,
      sha256: remoteDigest,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function resolveBaseShas(config) {
  return Object.fromEntries(config.targets.map((targetId) => {
    const node = config.graph.nodes.find((entry) => entry.id === targetId);
    if (!node?.baseRef) throw new Error(`configured propagation target ${targetId} has no baseRef`);
    const response = commandJson("gh", ["api", `repos/${node.repository}/commits/${node.baseRef}`]);
    const sha = String(response.sha || "").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`configured propagation target ${targetId} baseRef did not resolve exactly`);
    }
    return [targetId, sha];
  }));
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export function capturePackageReleasePropagation({
  config,
  upstreamRelease,
  expectedBaseShas,
  outputDir,
  configBytes = "",
} = {}) {
  const captured = createPackageReleasePropagationCapture({
    config,
    upstreamRelease,
    expectedBaseShas,
  });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "config.json"),
    configBytes || stableJson(captured.config),
  );
  fs.writeFileSync(path.join(outputDir, "upstream-release.json"), stableJson(captured.upstreamRelease));
  fs.writeFileSync(path.join(outputDir, "plan.json"), stableJson(captured.plan));
  for (const item of captured.works) {
    const targetDir = path.join(outputDir, "work", item.propagationKey);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "work.json"), stableJson(item.work));
    fs.writeFileSync(path.join(targetDir, "status.json"), stableJson(item.status));
  }
  return captured;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repository = required(args, "repository");
  const channel = required(args, "channel");
  const sourceSha = required(args, "source-sha").toLowerCase();
  const tag = required(args, "tag");
  const configPath = assertSourcePath(required(args, "config-path"));
  const releasePassportPath = path.resolve(required(args, "release-passport-path"));
  const outputDir = path.resolve(required(args, "output-dir"));
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("--source-sha must be an exact commit SHA");
  if (tag !== `v${tag.replace(/^v/, "")}`) throw new Error("--tag must be an exact v-prefixed release tag");
  const version = tag.slice(1);
  const configSource = readConfigAtSource(sourceSha, configPath, process.cwd());
  const sourceNode = configSource.normalized.graph.nodes.find(
    (node) => node.id === configSource.normalized.sourceNode,
  );
  const packageFact = resolvePackageFact(sourceNode.package, version);
  const tagTargetSha = resolveTagTarget(repository, tag);
  const releasePassport = verifyPublicReleasePassport({
    repository,
    tag,
    localPath: releasePassportPath,
  });
  const upstreamRelease = {
    repository,
    channel,
    tag,
    sourceSha,
    tagTargetSha,
    package: packageFact,
    releasePassport,
  };
  const expectedBaseShas = resolveBaseShas(configSource.normalized);
  const captured = capturePackageReleasePropagation({
    config: configSource.parsed,
    configBytes: configSource.bytes,
    upstreamRelease,
    expectedBaseShas,
    outputDir,
  });
  const artifactName = `package-propagation-work-${version}-${sourceSha}`;
  const workRoots = captured.works.map((item) => item.work.contentRoot);
  writeOutput("configured", "true");
  writeOutput("artifact-name", artifactName);
  writeOutput("work-roots-json", JSON.stringify(workRoots));
  process.stdout.write(stableJson({
    schemaVersion: 1,
    contract: "kungfu-buildchain-package-release-propagation-capture-result",
    artifactName,
    release: {
      repository,
      channel,
      tag,
      sourceSha,
      tagTargetSha,
      package: packageFact,
      releasePassport,
    },
    workCount: captured.works.length,
    works: captured.works.map((item) => ({
      target: item.target,
      repository: item.repository,
      propagationKey: item.propagationKey,
      workId: item.work.workId,
      workRoot: item.work.contentRoot,
      nextAction: item.status.nextAction,
    })),
  }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
