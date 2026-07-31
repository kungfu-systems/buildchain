import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
  publicationArtifactCandidateDigest,
} from "../packages/core/publication-artifact-candidate.js";
import {
  createPublicationSealedBundle,
  verifyPublicationSealedBundle,
} from "../packages/core/publication-sealed-bundle.js";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function file(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return {
    path: relativePath,
    size: fs.statSync(target).size,
    sha256: sha256(fs.readFileSync(target)),
  };
}

test("publication sealed bundle binds and verifies exact npm and release bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-sealed-bundle-"));
  const npm = file(root, ".buildchain/publication/npm-tarball/paper-0.1.0-alpha.4.tgz", "exact npm bytes");
  const pdf = file(root, "_build/main.pdf", "exact pdf bytes");
  const candidatePayload = {
    schemaVersion: 1,
    contract: PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
    repository: "kungfu-systems/paper",
    sourceSha: "a".repeat(40),
    sourceTreeSha: "b".repeat(40),
    runtimeSha: "c".repeat(40),
    manifestDigest: "d".repeat(64),
    passportDigest: "e".repeat(64),
    controllerReceiptDigest: "f".repeat(64),
    files: [npm, pdf].sort((left, right) => left.path.localeCompare(right.path)),
  };
  const candidate = {
    ...candidatePayload,
    candidateDigest: publicationArtifactCandidateDigest(candidatePayload),
  };
  const integrity = `sha512-${crypto
    .createHash("sha512")
    .update(fs.readFileSync(path.join(root, npm.path)))
    .digest("base64")}`;
  const manifest = createPublicationSealedBundle({
    candidate,
    packageName: "@kungfu-tech/paper",
    packageVersion: "0.1.0-alpha.4",
    npmTarballPath: npm.path,
    npmIntegrity: integrity,
    releaseAssetPaths: [pdf.path],
  });

  const verified = verifyPublicationSealedBundle({
    bundleRoot: root,
    manifest,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.root, `sha256:${candidate.candidateDigest}`);
  assert.equal(verified.npm.absolutePath, path.join(root, npm.path));
  assert.deepEqual(
    verified.releaseAssets.map((entry) => entry.path),
    [pdf.path],
  );
  assert.match(manifest.resumeCommand, /^buildchain paper resume /);

  fs.writeFileSync(path.join(root, pdf.path), "different bytes");
  assert.throws(
    () => verifyPublicationSealedBundle({ bundleRoot: root, manifest }),
    /publication sealed bundle file mismatch/,
  );
});
