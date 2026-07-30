#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createArtifactSigningRequest,
  validateArtifactSigningRequest,
} from "../packages/core/artifact-signing.js";
import { loadBuildchainConfig } from "../packages/core/buildchain-config.js";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

const INDEX_CONTRACT = "kungfu-buildchain-artifact-signing-request-index/v1";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function toPosix(value) {
  return String(value || "")
    .split(path.sep)
    .join("/");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest("hex")}`;
}

function safeId(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error(`unsafe artifact signing id: ${value}`);
  }
  return normalized;
}

function assertInside(root, target, label) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (path.resolve(root) !== path.resolve(target)) {
      throw new Error(`${label} must stay inside the build workspace`);
    }
  }
}

function containsPath(root, target) {
  const relative = path.relative(root, target);
  return (
    !relative || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resetGeneratedOutputRoot({
  workspace,
  cwd,
  outputRoot,
  protectedPaths = [],
}) {
  const protectedRoots = [workspace, cwd, ...protectedPaths];
  for (const protectedPath of protectedRoots) {
    if (containsPath(outputRoot, protectedPath)) {
      throw new Error(
        "signing request output must not contain the workspace, working directory, manifest, or a declared artifact",
      );
    }
  }
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
}

function walkSubject(subjectRoot) {
  const entries = [];
  function visit(current) {
    const stat = fs.lstatSync(current);
    const relative = toPosix(path.relative(subjectRoot, current)) || ".";
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(current);
      const resolved = path.resolve(path.dirname(current), target);
      assertInside(subjectRoot, resolved, `artifact symlink ${relative}`);
      entries.push({ path: relative, type: "symlink", target });
      return;
    }
    if (stat.isDirectory()) {
      if (relative !== ".") entries.push({ path: relative, type: "directory" });
      for (const name of fs.readdirSync(current).sort())
        visit(path.join(current, name));
      return;
    }
    if (!stat.isFile())
      throw new Error(`unsupported artifact filesystem entry: ${relative}`);
    entries.push({
      path: relative,
      type: "file",
      bytes: stat.size,
      digest: sha256File(current),
    });
  }
  visit(subjectRoot);
  return entries;
}

function subjectDescriptor(subjectPath) {
  const stat = fs.lstatSync(subjectPath);
  if (stat.isSymbolicLink())
    throw new Error("artifact root must not be a symlink");
  if (stat.isFile()) {
    return {
      bytes: stat.size,
      digest: sha256File(subjectPath),
      entries: [
        {
          path: path.basename(subjectPath),
          bytes: stat.size,
          digest: sha256File(subjectPath),
        },
      ],
    };
  }
  if (!stat.isDirectory())
    throw new Error("artifact must be a regular file or directory");
  const entries = walkSubject(subjectPath);
  const bytes = entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
  const digest = `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex")}`;
  return { bytes, digest, entries };
}

function normalizePlatform(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["macos", "mac", "darwin"].includes(normalized)) return "macos";
  if (["windows", "win32", "win"].includes(normalized)) return "windows";
  if (normalized === "linux") return "linux";
  return normalized;
}

function inferKind(subjectPath, declaredKind) {
  if (declaredKind && declaredKind !== "auto") return declaredKind;
  const lower = subjectPath.toLowerCase();
  const stat = fs.statSync(subjectPath);
  if (lower.endsWith(".app")) return "app-bundle";
  if (lower.endsWith(".framework")) return "framework-bundle";
  if (lower.endsWith(".xpc")) return "xpc-bundle";
  if (lower.endsWith(".plugin")) return "plugin-bundle";
  if (lower.endsWith(".dylib")) return "dylib";
  if (lower.endsWith(".pkg")) return "pkg";
  if (lower.endsWith(".dmg")) return "dmg";
  if (stat.isDirectory()) return "directory";
  if (/\.(?:zip|tar|tgz|gz|bz2|xz|7z)$/u.test(lower)) return "archive";
  return "binary";
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
}

function archiveSubject({ subjectPath, outputRoot, id, kind, platform }) {
  const artifactRoot = path.join(outputRoot, id);
  fs.mkdirSync(artifactRoot, { recursive: true });
  const stat = fs.statSync(subjectPath);
  let archivePath;
  let format;
  if (stat.isFile()) {
    archivePath = path.join(artifactRoot, path.basename(subjectPath));
    fs.copyFileSync(subjectPath, archivePath, fs.constants.COPYFILE_EXCL);
    format = "exact-file";
  } else if (
    platform === "macos" &&
    ["app-bundle", "framework-bundle", "plugin-bundle", "xpc-bundle"].includes(
      kind,
    )
  ) {
    archivePath = path.join(artifactRoot, "subject.ditto.zip");
    run("/usr/bin/ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      subjectPath,
      archivePath,
    ]);
    format = "ditto-zip";
  } else {
    archivePath = path.join(artifactRoot, "subject.tar");
    run("tar", [
      "-cf",
      archivePath,
      "-C",
      path.dirname(subjectPath),
      path.basename(subjectPath),
    ]);
    format = "tar";
  }
  return {
    file: toPosix(path.relative(outputRoot, archivePath)),
    format,
    bytes: fs.statSync(archivePath).size,
    digest: sha256File(archivePath),
  };
}

function verifyLifecycleBinding({
  manifest,
  workspace,
  subjectPath,
  descriptor,
}) {
  const byPath = new Map(
    (manifest.files || []).map((entry) => [toPosix(entry.path), entry]),
  );
  const relativeSubject = toPosix(path.relative(workspace, subjectPath));
  const files = descriptor.entries.filter(
    (entry) => entry.type !== "directory",
  );
  for (const entry of files) {
    if (entry.type === "symlink") continue;
    const manifestPath = fs.statSync(subjectPath).isFile()
      ? relativeSubject
      : `${relativeSubject}/${entry.path}`;
    const observed = byPath.get(manifestPath);
    if (!observed)
      throw new Error(
        `signed artifact file is absent from lifecycle manifest: ${manifestPath}`,
      );
    if (
      `sha256:${observed.sha256}` !== entry.digest ||
      Number(observed.size) !== entry.bytes
    ) {
      throw new Error(
        `signed artifact file does not match lifecycle manifest: ${manifestPath}`,
      );
    }
  }
}

export function sealArtifactSigningRequests({
  workspace = process.env.GITHUB_WORKSPACE || process.cwd(),
  cwd = process.env.BUILDCHAIN_SIGNING_CWD || ".",
  manifestPath = process.env.BUILDCHAIN_SIGNING_ARTIFACT_MANIFEST,
  outputRoot = process.env.BUILDCHAIN_SIGNING_OUTPUT_ROOT ||
    ".buildchain/signing/requests",
  repository = process.env.BUILDCHAIN_SOURCE_REPOSITORY ||
    process.env.GITHUB_REPOSITORY,
  sourceSha = process.env.BUILDCHAIN_SOURCE_SHA || process.env.GITHUB_SHA,
  sourceTreeSha = process.env.BUILDCHAIN_SOURCE_TREE_SHA,
  runtimeSha = process.env.BUILDCHAIN_RUNTIME_SHA,
  platformId = process.env.BUILDCHAIN_PLATFORM_ID,
} = {}) {
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedCwd = path.resolve(resolvedWorkspace, cwd);
  assertInside(resolvedWorkspace, resolvedCwd, "signing working directory");
  const loaded = loadBuildchainConfig(resolvedCwd);
  const declarations = loaded?.config?.signing?.artifacts || [];
  const selected = declarations.filter(
    (entry) =>
      entry.platforms.length === 0 || entry.platforms.includes(platformId),
  );
  const resolvedOutputRoot = path.resolve(resolvedWorkspace, outputRoot);
  assertInside(resolvedWorkspace, resolvedOutputRoot, "signing request output");
  if (selected.length === 0) {
    resetGeneratedOutputRoot({
      workspace: resolvedWorkspace,
      cwd: resolvedCwd,
      outputRoot: resolvedOutputRoot,
    });
    const index = { schemaVersion: 1, contract: INDEX_CONTRACT, requests: [] };
    const indexPath = path.join(resolvedOutputRoot, "index.json");
    fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    writeGitHubOutputs({
      "request-count": "0",
      "request-index": indexPath,
      "request-root": resolvedOutputRoot,
    });
    return index;
  }
  const resolvedManifest = path.resolve(
    resolvedWorkspace,
    required(manifestPath, "artifact manifest path"),
  );
  assertInside(resolvedWorkspace, resolvedManifest, "artifact manifest");
  const manifest = JSON.parse(fs.readFileSync(resolvedManifest, "utf8"));
  const platform = normalizePlatform(manifest.platform?.os || process.platform);
  const prepared = selected.map((declaration) => {
    const subjectPath = path.resolve(resolvedCwd, declaration.path);
    assertInside(
      resolvedWorkspace,
      subjectPath,
      `signing artifact ${declaration.id}`,
    );
    if (!fs.existsSync(subjectPath))
      throw new Error(
        `declared signing artifact does not exist: ${declaration.path}`,
      );
    const realSubject = fs.realpathSync(subjectPath);
    assertInside(
      fs.realpathSync(resolvedWorkspace),
      realSubject,
      `signing artifact ${declaration.id}`,
    );
    const descriptor = subjectDescriptor(subjectPath);
    verifyLifecycleBinding({
      manifest,
      workspace: resolvedWorkspace,
      subjectPath,
      descriptor,
    });
    return {
      declaration,
      subjectPath,
      descriptor,
      id: safeId(declaration.id),
      kind: inferKind(subjectPath, declaration.kind),
    };
  });
  resetGeneratedOutputRoot({
    workspace: resolvedWorkspace,
    cwd: resolvedCwd,
    outputRoot: resolvedOutputRoot,
    protectedPaths: [
      resolvedManifest,
      ...prepared.map((entry) => entry.subjectPath),
    ],
  });
  const requests = [];
  for (const { declaration, subjectPath, descriptor, id, kind } of prepared) {
    const transport = archiveSubject({
      subjectPath,
      outputRoot: resolvedOutputRoot,
      id,
      kind,
      platform,
    });
    const request = createArtifactSigningRequest({
      source: { repository, sha: sourceSha, treeSha: sourceTreeSha },
      runtime: { repository: "kungfu-systems/buildchain", sha: runtimeSha },
      artifact: {
        id: declaration.id,
        path: toPosix(path.relative(resolvedWorkspace, subjectPath)),
        kind,
        platform,
        arch: String(manifest.platform?.arch || process.arch).toLowerCase(),
        bytes: descriptor.bytes,
        digest: descriptor.digest,
        transport,
      },
      signature: {
        profile: declaration.profile,
        required: declaration.required,
      },
    });
    const check = validateArtifactSigningRequest(request);
    if (!check.ok)
      throw new Error(
        `generated signing request is invalid: ${check.issues.join(", ")}`,
      );
    const requestPath = path.join(resolvedOutputRoot, id, "request.json");
    fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
    requests.push({
      id: declaration.id,
      digest: request.digest,
      path: toPosix(path.relative(resolvedOutputRoot, requestPath)),
      required: request.signature.required,
      profile: request.signature.profile,
      platform: request.artifact.platform,
    });
  }
  const index = { schemaVersion: 1, contract: INDEX_CONTRACT, requests };
  const indexPath = path.join(resolvedOutputRoot, "index.json");
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  writeGitHubOutputs({
    "request-count": String(requests.length),
    "request-index": indexPath,
    "request-root": resolvedOutputRoot,
  });
  return index;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    sealArtifactSigningRequests();
  } catch (error) {
    console.error(
      `::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`,
    );
    process.exitCode = 1;
  }
}
