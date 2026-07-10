import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function defaultCommandRunner(command, args) {
  return spawnSync(command, args, {
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
  });
}

function resultStatus(result) {
  return result?.status ?? result?.exitCode ?? 0;
}

function resultText(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
}

function assertSha256(value) {
  const digest = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("expected SHA256 must be a 64-character hexadecimal digest");
  }
  return digest;
}

function isMissingHeadObject(result) {
  if (resultStatus(result) === 0) return false;
  return /(?:404|not found|nosuchkey)/i.test(resultText(result?.stderr));
}

function assertCommandSucceeded(result, label) {
  if (result?.error) throw result.error;
  if (resultStatus(result) !== 0) {
    const stderr = resultText(result?.stderr).trim();
    throw new Error(`${label} failed with exit code ${resultStatus(result)}${stderr ? `: ${stderr}` : ""}`);
  }
}

function checksumHexFromHead(head) {
  const encoded = String(head?.ChecksumSHA256 || "").trim();
  if (!encoded) return "";
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 32 ? decoded.toString("hex") : "";
}

export function verifyImmutableS3Object({
  bucket,
  key,
  expectedSha256,
  commandRunner = defaultCommandRunner,
} = {}) {
  const expected = assertSha256(expectedSha256);
  if (!String(bucket || "").trim() || !String(key || "").trim()) {
    throw new Error("immutable S3 verification requires bucket and key");
  }
  const head = commandRunner("aws", [
    "s3api",
    "head-object",
    "--bucket",
    bucket,
    "--key",
    key,
    "--checksum-mode",
    "ENABLED",
  ]);
  if (isMissingHeadObject(head)) {
    return { status: "missing", bucket, key, expectedSha256: expected };
  }
  assertCommandSucceeded(head, `head immutable object s3://${bucket}/${key}`);

  let stored = "";
  let source = "";
  try {
    stored = checksumHexFromHead(JSON.parse(resultText(head.stdout) || "{}"));
  } catch {
    stored = "";
  }
  if (stored) {
    source = "s3-checksum-sha256";
  } else {
    const download = commandRunner("aws", ["s3", "cp", `s3://${bucket}/${key}`, "-", "--only-show-errors"]);
    assertCommandSucceeded(download, `read immutable object s3://${bucket}/${key}`);
    const body = Buffer.isBuffer(download.stdout) ? download.stdout : Buffer.from(download.stdout || "");
    stored = crypto.createHash("sha256").update(body).digest("hex");
    source = "downloaded-object";
  }
  if (stored !== expected) {
    throw new Error(
      `immutable object digest mismatch for s3://${bucket}/${key}: expected ${expected}, got ${stored}`,
    );
  }
  return { status: "verified", bucket, key, sha256: stored, source };
}

function cliArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("usage: web-surface-immutable-object --bucket NAME --key KEY --sha256 DIGEST");
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = cliArgs(process.argv.slice(2));
    const result = verifyImmutableS3Object({
      bucket: args.bucket,
      key: args.key,
      expectedSha256: args.sha256,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error.message || error)}\n`);
    process.exitCode = 1;
  }
}
