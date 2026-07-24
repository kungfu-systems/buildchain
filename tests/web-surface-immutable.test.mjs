import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { verifyImmutableS3Object } from "../scripts/web-surface-immutable-object.mjs";

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

test("immutable S3 verification accepts stored SHA256 checksum", () => {
  const body = Buffer.from("immutable body\n");
  const calls = [];
  const result = verifyImmutableS3Object({
    bucket: "bucket",
    key: "archive/paper/v1/main.pdf",
    expectedSha256: sha256(body),
    commandRunner(command, args) {
      calls.push([command, args]);
      return {
        status: 0,
        stdout: Buffer.from(JSON.stringify({ ChecksumSHA256: body.length > 0
          ? crypto.createHash("sha256").update(body).digest("base64")
          : "" })),
        stderr: Buffer.alloc(0),
      };
    },
  });
  assert.equal(result.status, "verified");
  assert.equal(result.source, "s3-checksum-sha256");
  assert.equal(calls.length, 1);
});

test("immutable S3 verification falls back to byte hashing", () => {
  const body = Buffer.from("legacy immutable body\n");
  const calls = [];
  const result = verifyImmutableS3Object({
    bucket: "bucket",
    key: "archive/paper/v1/main.pdf",
    expectedSha256: sha256(body),
    commandRunner(command, args) {
      calls.push([command, args]);
      if (args[0] === "s3api") {
        return { status: 0, stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) };
      }
      return { status: 0, stdout: body, stderr: Buffer.alloc(0) };
    },
  });
  assert.equal(result.status, "verified");
  assert.equal(result.source, "downloaded-object");
  assert.equal(calls.length, 2);
});

test("immutable S3 verification reports missing objects without failing", () => {
  const result = verifyImmutableS3Object({
    bucket: "bucket",
    key: "archive/paper/v1/main.pdf",
    expectedSha256: "a".repeat(64),
    commandRunner() {
      return {
        status: 254,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("An error occurred (404) when calling HeadObject: Not Found"),
      };
    },
  });
  assert.equal(result.status, "missing");
});

test("immutable S3 verification rejects changed existing content", () => {
  assert.throws(
    () => verifyImmutableS3Object({
      bucket: "bucket",
      key: "archive/paper/v1/main.pdf",
      expectedSha256: sha256("expected\n"),
      commandRunner(command, args) {
        if (args[0] === "s3api") {
          return { status: 0, stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) };
        }
        return { status: 0, stdout: Buffer.from("changed\n"), stderr: Buffer.alloc(0) };
      },
    }),
    /immutable object digest mismatch/,
  );
});
