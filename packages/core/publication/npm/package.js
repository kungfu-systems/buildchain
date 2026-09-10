import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runNpm } from "./registry.js";
export function readPackageJson(cwd) {
  const filePath = path.join(cwd, "package.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`package.json not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parsePackResult(stdout) {
  const parsed = JSON.parse(stdout);
  const pack = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!pack?.name || !pack?.version) {
    throw new Error("npm pack did not return package name and version");
  }
  return {
    name: pack.name,
    version: pack.version,
    filename: pack.filename || "",
    integrity: pack.integrity || "",
    shasum: pack.shasum || "",
    entryCount: pack.entryCount || pack.files?.length || 0,
  };
}

export function artifactDigest(pack) {
  if (pack.integrity) {
    return pack.integrity;
  }
  if (pack.shasum) {
    return `sha1:${pack.shasum}`;
  }
  throw new Error("npm pack did not return integrity or shasum");
}

export function sealedPackResult(publication) {
  const tarballPath = publication.tarballPath || "";
  if (!tarballPath) {
    return undefined;
  }
  const resolved = path.resolve(tarballPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`sealed npm tarball is missing: ${resolved}`);
  }
  const bytes = fs.readFileSync(resolved);
  const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  const shasum = crypto.createHash("sha1").update(bytes).digest("hex");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const expectedIntegrity = publication.integrity || "";
  const expectedSha256 = (publication.sha256 || "").replace(/^sha256:/, "");
  if (expectedIntegrity && integrity !== expectedIntegrity) {
    throw new Error(
      `sealed npm tarball integrity mismatch: expected ${expectedIntegrity}, got ${integrity}`,
    );
  }
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw new Error(
      `sealed npm tarball sha256 mismatch: expected ${expectedSha256}, got ${sha256}`,
    );
  }
  return {
    filename: path.basename(resolved),
    integrity,
    shasum,
    sha256,
    bytes: bytes.length,
    entryCount: 0,
    tarballPath: resolved,
    sealed: true,
  };
}

export function packNpmArtifact({
  cwd,
  registry,
  env,
  outputDirectory,
  ignoreScripts = false,
}) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const result = runNpm({
    cwd,
    env,
    args: [
      "pack",
      "--json",
      "--pack-destination",
      outputDirectory,
      ...(ignoreScripts ? ["--ignore-scripts"] : []),
      ...(registry ? [`--registry=${registry}`] : []),
    ],
  });
  const pack = parsePackResult(result.stdout);
  return {
    ...pack,
    tarballPath: path.join(outputDirectory, pack.filename),
    rawResult: result.stdout,
  };
}
export function materializedPackResult({ cwd, registry, env }) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-npm-pack-"),
  );
  try {
    const pack = packNpmArtifact({
      cwd,
      registry,
      env,
      outputDirectory: temporaryRoot,
    });
    return { ...pack, temporaryRoot };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
