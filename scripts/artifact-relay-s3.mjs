#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

const CONTRACT = "kungfu-buildchain-artifact-relay-s3";

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function toPosix(value) {
  return String(value || "").replaceAll(path.sep, "/");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function splitLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function listFiles(root, rel) {
  const normalized = String(rel || "").replace(/\\/g, "/").replace(/\/\*\*\/?\*?$/, "");
  const target = path.isAbsolute(normalized) ? normalized : path.join(root, normalized);
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

function collectGroupFiles(root, paths) {
  const files = new Set();
  for (const entry of paths) {
    for (const file of listFiles(root, entry)) {
      files.add(path.resolve(file));
    }
  }
  return [...files].sort();
}

function safeSegment(value, fallback = "artifact") {
  const segment = String(value || fallback)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return segment || fallback;
}

function normalizePrefix(value) {
  return String(value || "buildchain-artifacts").replace(/^\/+|\/+$/g, "") || "buildchain-artifacts";
}

function assertSafeRelativePath(value) {
  const normalized = path.posix.normalize(String(value || "").replace(/\\/g, "/"));
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    throw new Error(`unsafe relay object relative path: ${value}`);
  }
  return normalized;
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Key(key) {
  return String(key || "")
    .split("/")
    .map((segment) => encodePathSegment(segment))
    .join("/");
}

function s3EndpointHost(region) {
  return String(region || "").startsWith("cn-")
    ? `s3.${region}.amazonaws.com.cn`
    : `s3.${region}.amazonaws.com`;
}

function s3RequestTarget({ bucket, key, region }) {
  const safeBucket = String(bucket || "");
  const hostSuffix = s3EndpointHost(region);
  const encodedKey = encodeS3Key(key);
  if (/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(safeBucket) && !safeBucket.includes("..") && !safeBucket.includes(".")) {
    return {
      host: `${safeBucket}.${hostSuffix}`,
      path: `/${encodedKey}`,
    };
  }
  return {
    host: hostSuffix,
    path: `/${encodePathSegment(safeBucket)}/${encodedKey}`,
  };
}

function awsCredentials() {
  const accessKeyId = env("AWS_ACCESS_KEY_ID");
  const secretAccessKey = env("AWS_SECRET_ACCESS_KEY");
  const sessionToken = env("AWS_SESSION_TOKEN");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for S3 artifact relay");
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}

function signS3Request({ method, bucket, key, region, payloadHash, contentLength = 0 }) {
  if (!region) throw new Error("S3 relay region is required");
  const credentials = awsCredentials();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const target = s3RequestTarget({ bucket, key, region });
  const headers = {
    host: target.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentLength > 0 || method === "PUT") {
    headers["content-length"] = String(contentLength);
  }
  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const canonicalRequest = [
    method,
    target.path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  return {
    method,
    host: target.host,
    path: target.path,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function requestS3({ method, bucket, key, region, payloadHash, contentLength = 0, bodyPath = "", outputPath = "" }) {
  return new Promise((resolve, reject) => {
    const request = signS3Request({ method, bucket, key, region, payloadHash, contentLength });
    const req = https.request(
      {
        method: request.method,
        host: request.host,
        path: request.path,
        headers: request.headers,
      },
      (res) => {
        const chunks = [];
        const output = outputPath ? fs.createWriteStream(outputPath) : null;
        if (output) {
          output.on("error", reject);
        }
        res.on("data", (chunk) => {
          if (output && res.statusCode >= 200 && res.statusCode < 300) {
            output.write(chunk);
          } else {
            chunks.push(chunk);
          }
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            if (output) {
              output.destroy();
              fs.rmSync(outputPath, { force: true });
            }
            reject(new Error(`S3 ${method} s3://${bucket}/${key} failed with HTTP ${res.statusCode}: ${body.slice(0, 500)}`));
            return;
          }
          if (output) {
            output.end(resolve);
            return;
          }
          resolve();
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (bodyPath) {
      fs.createReadStream(bodyPath).on("error", reject).pipe(req);
    } else {
      req.end();
    }
  });
}

function fakeS3Path(bucket, key) {
  const fakeRoot = env("BUILDCHAIN_ARTIFACT_RELAY_FAKE_S3_ROOT");
  if (!fakeRoot) return "";
  return path.join(fakeRoot, bucket, ...assertSafeRelativePath(key).split("/"));
}

async function putS3Object({ bucket, key, region, filePath, sha256, size }) {
  const fakePath = fakeS3Path(bucket, key);
  if (fakePath) {
    fs.mkdirSync(path.dirname(fakePath), { recursive: true });
    fs.copyFileSync(filePath, fakePath);
    return;
  }
  await requestS3({
    method: "PUT",
    bucket,
    key,
    region,
    payloadHash: sha256,
    contentLength: size,
    bodyPath: filePath,
  });
}

async function getS3Object({ bucket, key, region, targetPath }) {
  const fakePath = fakeS3Path(bucket, key);
  if (fakePath) {
    fs.copyFileSync(fakePath, targetPath);
    return;
  }
  await requestS3({
    method: "GET",
    bucket,
    key,
    region,
    payloadHash: sha256Hex(""),
    outputPath: targetPath,
  });
}

async function deleteS3Object({ bucket, key, region }) {
  const fakePath = fakeS3Path(bucket, key);
  if (fakePath) {
    fs.rmSync(fakePath, { force: true });
    return;
  }
  await requestS3({
    method: "DELETE",
    bucket,
    key,
    region,
    payloadHash: sha256Hex(""),
  });
}

function writeManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function resolveUploadGroups() {
  return [
    {
      role: "payload",
      artifactName: env("BUILDCHAIN_ARTIFACT_RELAY_PAYLOAD_ARTIFACT_NAME"),
      paths: splitLines(env("BUILDCHAIN_ARTIFACT_RELAY_PAYLOAD_PATHS")),
      required: true,
    },
    {
      role: "manifest",
      artifactName: env("BUILDCHAIN_ARTIFACT_RELAY_MANIFEST_ARTIFACT_NAME"),
      paths: splitLines(env("BUILDCHAIN_ARTIFACT_RELAY_MANIFEST_PATHS")),
      required: true,
    },
    {
      role: "diagnostics",
      artifactName: env("BUILDCHAIN_ARTIFACT_RELAY_DIAGNOSTICS_ARTIFACT_NAME"),
      paths: splitLines(env("BUILDCHAIN_ARTIFACT_RELAY_DIAGNOSTICS_PATHS")),
      required: true,
    },
  ];
}

export async function uploadRelayArtifacts({
  workspace = env("BUILDCHAIN_ARTIFACT_RELAY_WORKSPACE", process.cwd()),
  manifestPath = env("BUILDCHAIN_ARTIFACT_RELAY_MANIFEST_PATH", ".buildchain/artifacts/relay-manifest.json"),
  bucket = env("BUILDCHAIN_ARTIFACT_RELAY_BUCKET"),
  region = env("BUILDCHAIN_ARTIFACT_RELAY_REGION"),
  prefix = env("BUILDCHAIN_ARTIFACT_RELAY_PREFIX", "buildchain-artifacts"),
  groups = resolveUploadGroups(),
  repository = env("GITHUB_REPOSITORY"),
  runId = env("GITHUB_RUN_ID"),
  runAttempt = env("GITHUB_RUN_ATTEMPT"),
  sourceSha = env("BUILDCHAIN_ARTIFACT_RELAY_SOURCE_SHA", env("GITHUB_SHA")),
  platformId = env("BUILDCHAIN_ARTIFACT_RELAY_PLATFORM_ID", os.platform()),
  platformName = env("BUILDCHAIN_ARTIFACT_RELAY_PLATFORM_NAME", platformId),
} = {}) {
  if (!bucket) throw new Error("BUILDCHAIN_ARTIFACT_RELAY_BUCKET is required");
  if (!region) throw new Error("BUILDCHAIN_ARTIFACT_RELAY_REGION is required");
  const resolvedWorkspace = path.resolve(workspace);
  const basePrefix = [
    normalizePrefix(prefix),
    safeSegment(repository || "repository"),
    safeSegment(runId || "run"),
    safeSegment(runAttempt || "attempt"),
    safeSegment(sourceSha || "sha"),
    safeSegment(platformId || "platform"),
  ].join("/");
  const manifestGroups = [];

  for (const group of groups) {
    const artifactName = String(group.artifactName || "").trim();
    if (!artifactName) {
      throw new Error(`relay ${group.role} artifact name is required`);
    }
    const files = collectGroupFiles(resolvedWorkspace, group.paths || []);
    if (group.required && files.length === 0) {
      throw new Error(`relay ${group.role} artifact ${artifactName} matched no files`);
    }
    const groupPrefix = `${basePrefix}/${safeSegment(group.role)}/${safeSegment(artifactName)}`;
    const objects = [];
    for (const file of files) {
      const relativePath = assertSafeRelativePath(toPosix(path.relative(resolvedWorkspace, file)));
      const stat = fs.statSync(file);
      const sha256 = sha256File(file);
      const key = `${groupPrefix}/${relativePath}`;
      await putS3Object({ bucket, key, region, filePath: file, sha256, size: stat.size });
      objects.push({
        relativePath,
        size: stat.size,
        sha256,
        bucket,
        key,
        uri: `s3://${bucket}/${key}`,
      });
    }
    manifestGroups.push({
      role: group.role,
      artifactName,
      fileCount: objects.length,
      totalBytes: objects.reduce((sum, object) => sum + object.size, 0),
      objects,
    });
  }

  const manifest = {
    schemaVersion: 1,
    contract: CONTRACT,
    transferMode: "s3-to-github-artifacts",
    provider: "s3",
    generatedAt: new Date().toISOString(),
    repository,
    runId,
    runAttempt,
    sourceSha,
    platform: {
      id: platformId,
      name: platformName,
    },
    s3: {
      bucket,
      region,
      prefix: basePrefix,
    },
    groups: manifestGroups,
  };
  const resolvedManifestPath = path.resolve(resolvedWorkspace, manifestPath);
  writeManifest(resolvedManifestPath, manifest);
  writeGitHubOutputs({
    "relay-manifest-path": toPosix(path.relative(resolvedWorkspace, resolvedManifestPath)),
    "relay-object-count": String(manifestGroups.reduce((sum, group) => sum + group.fileCount, 0)),
    "relay-total-bytes": String(manifestGroups.reduce((sum, group) => sum + group.totalBytes, 0)),
  });
  return manifest;
}

function findRelayManifest(inputRoot, expectedPlatformId = "") {
  const matches = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const current = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(current);
      } else if (entry.name === "relay-manifest.json") {
        const manifest = JSON.parse(fs.readFileSync(current, "utf8"));
        if (manifest.contract === CONTRACT && (!expectedPlatformId || manifest.platform?.id === expectedPlatformId)) {
          matches.push({ path: current, manifest });
        }
      }
    }
  }
  walk(path.resolve(inputRoot));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one relay-manifest.json${expectedPlatformId ? ` for ${expectedPlatformId}` : ""}, found ${matches.length}`);
  }
  return matches[0];
}

export async function downloadRelayArtifacts({
  inputRoot = env("BUILDCHAIN_ARTIFACT_RELAY_INPUT_ROOT", ".buildchain/downloaded-relay-manifests"),
  outputRoot = env("BUILDCHAIN_ARTIFACT_RELAY_OUTPUT_ROOT", ".buildchain/relayed-artifacts"),
  region = env("BUILDCHAIN_ARTIFACT_RELAY_REGION"),
  platformId = env("BUILDCHAIN_ARTIFACT_RELAY_PLATFORM_ID", ""),
} = {}) {
  const { manifest } = findRelayManifest(inputRoot, platformId);
  const resolvedOutputRoot = path.resolve(outputRoot);
  const effectiveRegion = region || manifest.s3?.region || "";
  if (!effectiveRegion) {
    throw new Error("relay download region is required");
  }
  const outputs = {};
  let objectCount = 0;
  let totalBytes = 0;
  for (const group of manifest.groups || []) {
    const groupDir = path.join(resolvedOutputRoot, safeSegment(group.role));
    fs.mkdirSync(groupDir, { recursive: true });
    for (const object of group.objects || []) {
      const relativePath = assertSafeRelativePath(object.relativePath);
      const targetPath = path.join(groupDir, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      await getS3Object({ bucket: object.bucket, key: object.key, region: effectiveRegion, targetPath });
      const actualSha256 = sha256File(targetPath);
      if (actualSha256 !== object.sha256) {
        throw new Error(`relay sha256 mismatch for ${relativePath}: expected ${object.sha256}, got ${actualSha256}`);
      }
      objectCount += 1;
      totalBytes += Number(object.size || 0);
    }
    outputs[`${group.role}-path`] = toPosix(path.relative(process.cwd(), groupDir));
    outputs[`${group.role}-artifact-name`] = group.artifactName || "";
  }
  const downloadedManifestPath = path.join(resolvedOutputRoot, "relay-manifest.downloaded.json");
  writeManifest(downloadedManifestPath, {
    ...manifest,
    downloadedAt: new Date().toISOString(),
    downloadedObjectCount: objectCount,
    downloadedTotalBytes: totalBytes,
  });
  writeGitHubOutputs({
    ...outputs,
    "relay-downloaded-manifest-path": toPosix(path.relative(process.cwd(), downloadedManifestPath)),
    "relay-downloaded-object-count": String(objectCount),
    "relay-downloaded-total-bytes": String(totalBytes),
  });
  return { manifest, objectCount, totalBytes };
}

export async function cleanupRelayArtifacts({
  inputRoot = env("BUILDCHAIN_ARTIFACT_RELAY_INPUT_ROOT", ".buildchain/downloaded-relay-manifests"),
  region = env("BUILDCHAIN_ARTIFACT_RELAY_REGION"),
  platformId = env("BUILDCHAIN_ARTIFACT_RELAY_PLATFORM_ID", ""),
} = {}) {
  const { manifest } = findRelayManifest(inputRoot, platformId);
  const effectiveRegion = region || manifest.s3?.region || "";
  if (!effectiveRegion) {
    throw new Error("relay cleanup region is required");
  }
  let objectCount = 0;
  let totalBytes = 0;
  for (const group of manifest.groups || []) {
    for (const object of group.objects || []) {
      await deleteS3Object({ bucket: object.bucket, key: object.key, region: effectiveRegion });
      objectCount += 1;
      totalBytes += Number(object.size || 0);
    }
  }
  writeGitHubOutputs({
    "relay-cleaned-object-count": String(objectCount),
    "relay-cleaned-total-bytes": String(totalBytes),
  });
  return { manifest, objectCount, totalBytes };
}

async function main() {
  const command = process.argv[2] || "";
  if (command === "upload") {
    await uploadRelayArtifacts();
    return;
  }
  if (command === "download") {
    await downloadRelayArtifacts();
    return;
  }
  if (command === "cleanup") {
    await cleanupRelayArtifacts();
    return;
  }
  throw new Error("usage: artifact-relay-s3.mjs <upload|download|cleanup>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  });
}
