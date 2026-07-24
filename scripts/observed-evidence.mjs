#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const OBSERVED_EVIDENCE_CONTRACT = "kungfu-buildchain-observed-evidence-bundle";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function safeRelative(value, label) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) throw new Error(`invalid ${label}: ${value || "<empty>"}`);
  return normalized;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertHex(value, label) {
  if (!/^[0-9a-f]{64}$/.test(String(value || ""))) throw new Error(`${label} must be a lowercase sha256 hex digest`);
}

export function validateObservedEvidenceBundle({ manifestPath, artifactRoot = path.dirname(manifestPath) }) {
  const resolvedManifest = path.resolve(manifestPath);
  const root = path.resolve(artifactRoot);
  const manifest = readJson(resolvedManifest);
  if (manifest.schemaVersion !== 1 || manifest.contract !== OBSERVED_EVIDENCE_CONTRACT) {
    throw new Error(`observed evidence manifest must be ${OBSERVED_EVIDENCE_CONTRACT} schemaVersion 1`);
  }
  const snapshotId = String(manifest.snapshot?.id || "");
  if (!snapshotId || !/^[A-Za-z0-9._:+-]+$/.test(snapshotId)) throw new Error("snapshot.id is invalid");
  if (!Number.isFinite(Date.parse(manifest.snapshot?.observedAt || ""))) throw new Error("snapshot.observedAt must be ISO-8601");
  const immutable = manifest.publication?.immutable || {};
  const latest = manifest.publication?.latest || {};
  const entries = [["immutable", immutable], ["latest", latest]].map(([kind, entry]) => {
    const source = safeRelative(entry.source, `${kind}.source`);
    const key = safeRelative(entry.key, `${kind}.key`);
    const file = path.resolve(root, source);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error(`${kind}.source escapes artifact root`);
    if (!fs.statSync(file).isFile()) throw new Error(`${kind}.source is not a file: ${source}`);
    assertHex(entry.sha256, `${kind}.sha256`);
    const actual = sha256(file);
    if (actual !== entry.sha256) throw new Error(`${kind}.sha256 does not match ${source}`);
    const document = readJson(file);
    if (document.snapshotId !== snapshotId) throw new Error(`${kind} document snapshotId does not match manifest`);
    return { kind, source, key, file, sha256: actual, contentType: entry.contentType || "application/json" };
  });
  if (!entries[0].key.includes(`/${snapshotId}.json`)) throw new Error("immutable key must bind snapshot.id below a versioned path");
  if (entries[0].key === entries[1].key) throw new Error("immutable and latest keys must differ");
  const invalidationPaths = [...new Set(manifest.publication?.invalidationPaths || [])];
  if (invalidationPaths.some((entry) => typeof entry !== "string" || !entry.startsWith("/") || entry.includes(".."))) {
    throw new Error("invalidation paths must be absolute viewer paths without traversal");
  }
  return { manifest, manifestPath: resolvedManifest, artifactRoot: root, snapshotId, entries, invalidationPaths };
}

function defaultRunner(args) {
  const result = spawnSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status ?? 1, stdout: String(result.stdout || ""), stderr: String(result.stderr || result.error?.message || "") };
}

function jsonOutput(result) {
  try { return JSON.parse(result.stdout || "{}"); } catch { return {}; }
}

function headObject(runner, bucket, key) {
  return runner(["s3api", "head-object", "--bucket", bucket, "--key", key]);
}

function headEvidence(result) {
  if (result.status !== 0) return null;
  const value = jsonOutput(result);
  return {
    sha256: String(value.Metadata?.sha256 || ""),
    snapshotId: String(value.Metadata?.["snapshot-id"] || ""),
    etag: String(value.ETag || "").replaceAll('"', ""),
    versionId: String(value.VersionId || ""),
  };
}

function base64Digest(hex) {
  return Buffer.from(hex, "hex").toString("base64");
}

function putArgs({ bucket, entry, snapshotId, immutable }) {
  const args = [
    "s3api", "put-object", "--bucket", bucket, "--key", entry.key, "--body", entry.file,
    "--content-type", entry.contentType,
    "--cache-control", immutable ? "public,max-age=31536000,immutable" : "public,max-age=0,must-revalidate",
    "--checksum-sha256", base64Digest(entry.sha256),
    "--metadata", `snapshot-id=${snapshotId},sha256=${entry.sha256}`,
  ];
  if (immutable) args.push("--if-none-match", "*");
  return args;
}

function assertHeadMatches(head, entry, snapshotId, label) {
  if (!head || head.sha256 !== entry.sha256 || head.snapshotId !== snapshotId) {
    throw new Error(`${label} object does not match the admitted snapshot and sha256`);
  }
}

export function publishObservedEvidence(options, { commandRunner = defaultRunner } = {}) {
  const bundle = validateObservedEvidenceBundle(options);
  const bucket = String(options.bucket || "").trim();
  if (!bucket) throw new Error("bucket is required");
  const distributionId = String(options.distributionId || "").trim();
  const dryRun = options.dryRun !== false;
  const [immutable, latest] = bundle.entries;
  const receipt = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-observed-evidence-publication-receipt",
    status: dryRun ? "planned" : "applying",
    dryRun,
    snapshotId: bundle.snapshotId,
    observedAt: bundle.manifest.snapshot.observedAt,
    bucket,
    distributionId,
    immutable: { key: immutable.key, sha256: immutable.sha256, status: "planned" },
    latest: { key: latest.key, sha256: latest.sha256, status: "planned" },
    previousLatest: null,
    invalidationPaths: bundle.invalidationPaths,
    operations: [],
  };
  if (dryRun) return receipt;

  const beforeImmutable = headEvidence(headObject(commandRunner, bucket, immutable.key));
  if (beforeImmutable) {
    assertHeadMatches(beforeImmutable, immutable, bundle.snapshotId, "existing immutable");
    receipt.immutable.status = "reused";
  } else {
    const put = commandRunner(putArgs({ bucket, entry: immutable, snapshotId: bundle.snapshotId, immutable: true }));
    receipt.operations.push({ action: "put-immutable", status: put.status });
    if (put.status !== 0) {
      const concurrent = headEvidence(headObject(commandRunner, bucket, immutable.key));
      assertHeadMatches(concurrent, immutable, bundle.snapshotId, "concurrent immutable");
      receipt.immutable.status = "reused-concurrent";
    } else {
      receipt.immutable.status = "written";
    }
  }
  const verifiedImmutable = headEvidence(headObject(commandRunner, bucket, immutable.key));
  assertHeadMatches(verifiedImmutable, immutable, bundle.snapshotId, "verified immutable");
  receipt.immutable.verification = verifiedImmutable;

  receipt.previousLatest = headEvidence(headObject(commandRunner, bucket, latest.key));
  const latestPut = commandRunner(putArgs({ bucket, entry: latest, snapshotId: bundle.snapshotId, immutable: false }));
  receipt.operations.push({ action: "advance-latest", status: latestPut.status });
  if (latestPut.status !== 0) throw new Error(`latest alias update failed: ${latestPut.stderr || latestPut.stdout}`);
  const verifiedLatest = headEvidence(headObject(commandRunner, bucket, latest.key));
  assertHeadMatches(verifiedLatest, latest, bundle.snapshotId, "verified latest");
  receipt.latest = { ...receipt.latest, status: "written", verification: verifiedLatest };

  if (distributionId && bundle.invalidationPaths.length > 0) {
    const invalidation = commandRunner([
      "cloudfront", "create-invalidation", "--distribution-id", distributionId,
      "--paths", ...bundle.invalidationPaths,
    ]);
    receipt.operations.push({ action: "invalidate-cdn", status: invalidation.status, result: jsonOutput(invalidation) });
    if (invalidation.status !== 0) throw new Error(`CloudFront invalidation failed: ${invalidation.stderr || invalidation.stdout}`);
  }
  receipt.status = "published";
  receipt.publishedAt = new Date().toISOString();
  return receipt;
}

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const output = arg("output");
    const result = publishObservedEvidence({
      manifestPath: arg("manifest"),
      artifactRoot: arg("artifact-root", path.dirname(arg("manifest"))),
      bucket: arg("bucket"),
      distributionId: arg("distribution-id"),
      dryRun: arg("execute", "false") !== "true",
    });
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, json); }
    else process.stdout.write(json);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}
