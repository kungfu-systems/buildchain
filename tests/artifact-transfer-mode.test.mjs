import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveArtifactTransferMode,
  writeArtifactTransferOutputs,
} from "../scripts/resolve-artifact-transfer-mode.mjs";

test("artifact transfer resolver preserves GitHub artifact defaults", () => {
  assert.deepEqual(resolveArtifactTransferMode({}), {
    mode: "github-artifacts",
    s3Bucket: "",
    s3Region: "",
    s3Prefix: "",
    oidcAudience: "",
  });
});

test("artifact transfer resolver validates S3 roles and China audience", () => {
  const resolution = resolveArtifactTransferMode({
    INPUT_TRANSFER_MODE: "s3-to-github-artifacts",
    VAR_S3_BUCKET: "relay-bucket",
    VAR_S3_REGION: "cn-northwest-1",
    VAR_S3_UPLOAD_ROLE_ARN: "upload-role",
    VAR_S3_DOWNLOAD_ROLE_ARN: "download-role",
  });
  assert.equal(resolution.s3Prefix, "buildchain-artifacts");
  assert.equal(resolution.oidcAudience, "sts.amazonaws.com.cn");
  assert.throws(
    () =>
      resolveArtifactTransferMode({
        INPUT_TRANSFER_MODE: "s3-to-github-artifacts",
      }),
    /requires artifact-relay-s3-bucket/,
  );
});

test("artifact transfer resolver writes the stable workflow output contract", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-artifact-transfer-"),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const outputPath = path.join(temporaryRoot, "github-output");
  writeArtifactTransferOutputs(outputPath, resolveArtifactTransferMode({}));
  assert.equal(
    fs.readFileSync(outputPath, "utf8"),
    "mode=github-artifacts\ns3-bucket=\ns3-region=\ns3-prefix=\noidc-audience=\n",
  );
});
