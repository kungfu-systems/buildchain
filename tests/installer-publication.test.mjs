// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INSTALLER_EVIDENCE_SCHEMA,
  validateInstallerPublication,
  verifyInstallerPublicReadback,
} from "../scripts/installer-publication.mjs";

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-installer-"));
  const immutablePath = "installers/v1/alpha/0123456789abcdef";
  const contents = {
    "install.sh": Buffer.from("#!/bin/sh\nexit 0\n"),
    "install.ps1": Buffer.from("exit 0\r\n"),
  };
  fs.mkdirSync(path.join(root, immutablePath), { recursive: true });
  const assets = Object.entries(contents).map(([name, bytes]) => {
    fs.writeFileSync(path.join(root, name), bytes);
    fs.writeFileSync(path.join(root, immutablePath, name), bytes);
    return {
      name,
      contentType:
        name === "install.sh"
          ? "text/x-shellscript; charset=utf-8"
          : "text/plain; charset=utf-8",
      size: bytes.length,
      digest: digest(bytes),
      friendlyUrl: `https://kungfu.tech/${name}`,
      immutableUrl: `https://kungfu.tech/${immutablePath}/${name}`,
    };
  });
  const publication = {
    schema: "kungfu.bootstrap-installer-publication/v1",
    installerVersion: "v1",
    channel: "alpha",
    sourceCommit: "a".repeat(40),
    channelUrl: "https://releases.kungfu.tech/channels/alpha.json",
    channelPayloadRoot: `sha256:${"1".repeat(64)}`,
    channelFileDigest: `sha256:${"2".repeat(64)}`,
    releasePassport: {
      ref: "buildchain:release-candidate-passport/fixture",
      root: `sha256:${"3".repeat(64)}`,
    },
    immutablePath,
    entries: [
      {
        platform: "linux",
        architecture: "x64",
        version: "4.0.0-alpha.1",
        sourceCommit: "a".repeat(40),
        manifestRoot: `sha256:${"4".repeat(64)}`,
        artifactRoot: `sha256:${"5".repeat(64)}`,
        artifactUrl:
          "https://github.com/kungfu-systems/kungfu/releases/download/v4.0.0-alpha.1/kungfu-cli-linux-x64.tar.gz",
        artifactSize: 4096,
        artifactDigest: `sha256:${"6".repeat(64)}`,
        artifactSignature: "sigstore:fixture",
        archiveName: "kungfu-cli-linux-x64.tar.gz",
        archiveBase: "kungfu-cli-linux-x64",
      },
    ],
    assets,
  };
  return { root, publication, contents };
}

test("installer publication binds friendly and immutable bytes", () => {
  const value = fixture();
  try {
    const evidence = validateInstallerPublication({
      publication: value.publication,
      artifactRoot: value.root,
    });
    assert.equal(evidence.schema, INSTALLER_EVIDENCE_SCHEMA);
    assert.equal(evidence.state, "verified");
    assert.match(evidence.evidenceRoot, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(
      evidence.assets.map((asset) => asset.name),
      ["install.ps1", "install.sh"],
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("installer publication fails when friendly bytes drift", () => {
  const value = fixture();
  try {
    fs.writeFileSync(path.join(value.root, "install.sh"), "tampered\n");
    assert.throws(
      () =>
        validateInstallerPublication({
          publication: value.publication,
          artifactRoot: value.root,
        }),
      /differs from publication metadata/,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("installer publication rejects an unbound friendly URL", () => {
  const value = fixture();
  try {
    value.publication.assets[0].friendlyUrl =
      "https://example.invalid/install.sh";
    assert.throws(
      () =>
        validateInstallerPublication({
          publication: value.publication,
          artifactRoot: value.root,
        }),
      /URL mapping is invalid/,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("installer publication rejects symlinks and MIME drift", () => {
  const value = fixture();
  try {
    const target = path.join(value.root, "install.sh");
    fs.rmSync(target);
    fs.symlinkSync("install.ps1", target);
    assert.throws(
      () =>
        validateInstallerPublication({
          publication: value.publication,
          artifactRoot: value.root,
        }),
      /non-symlink/,
    );

    fs.rmSync(target);
    fs.writeFileSync(target, value.contents["install.sh"]);
    value.publication.assets.find(
      (asset) => asset.name === "install.sh",
    ).contentType = "text/plain";
    assert.throws(
      () =>
        validateInstallerPublication({
          publication: value.publication,
          artifactRoot: value.root,
        }),
      /contentType is invalid/,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("public read-back checks bytes, content type, and cache policy", async () => {
  const value = fixture();
  try {
    const byUrl = new Map(
      value.publication.assets.flatMap((asset) => [
        [
          asset.friendlyUrl,
          {
            bytes: value.contents[asset.name],
            cache: "public,max-age=300,must-revalidate",
            type: asset.contentType,
          },
        ],
        [
          asset.immutableUrl,
          {
            bytes: value.contents[asset.name],
            cache: "public,max-age=31536000,immutable",
            type: asset.contentType,
          },
        ],
      ]),
    );
    const fetchImpl = async (url) => {
      const item = byUrl.get(url);
      return {
        status: item ? 200 : 404,
        headers: new Headers({
          "content-type": item?.type || "text/html",
          "cache-control": item?.cache || "no-cache",
          etag: '"fixture"',
          "x-amz-version-id": "fixture-version",
        }),
        async arrayBuffer() {
          return item?.bytes || Buffer.alloc(0);
        },
      };
    };
    const evidence = await verifyInstallerPublicReadback({
      publication: value.publication,
      fetchImpl,
    });
    assert.equal(evidence.state, "public-readback-verified");
    assert.equal(evidence.observations.length, 4);

    byUrl.get(value.publication.assets[0].friendlyUrl).cache =
      "public,max-age=86400";
    await assert.rejects(
      verifyInstallerPublicReadback({
        publication: value.publication,
        fetchImpl,
      }),
      /not revalidated/,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
