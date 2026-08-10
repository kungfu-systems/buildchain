import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  validatePublicationCommitEvidence,
  verifyInstallerBundleReadback,
} from "../scripts/publication-commit-evidence.mjs";

const SOURCE_SHA = "1".repeat(40);
const RELEASE_SHA = "2".repeat(40);
const CANDIDATE_SOURCE_SHA = "3".repeat(40);
const ROOT = `sha256:${"a".repeat(64)}`;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixture() {
  return {
    schema: "kungfu-buildchain-publication-commit-evidence/v1",
    status: "passed",
    identity: {
      version: "4.0.0-alpha.2",
      sourceSha: SOURCE_SHA,
      releaseSha: RELEASE_SHA,
      releaseTag: "v4.0.0-alpha.2",
    },
    publication: {
      url: "https://kungfu.tech/.well-known/kungfu/alpha.json",
      payloadRoot: ROOT,
    },
    readback: {
      status: "passed",
      url: "https://kungfu.tech/.well-known/kungfu/alpha.json",
      payloadRoot: ROOT,
    },
    recovery: {
      previousAuthority: "preserved",
      rollbackReference: "sha256:previous",
    },
  };
}

const expected = {
  version: "4.0.0-alpha.2",
  sourceSha: SOURCE_SHA,
  releaseSha: RELEASE_SHA,
  releaseTag: "v4.0.0-alpha.2",
};

function installerFixture(sourceCommit = CANDIDATE_SOURCE_SHA) {
  const releaseBase =
    "https://github.com/kungfu-systems/kungfu/releases/download/v4.0.0-alpha.2";
  const immutablePath = `installers/v1/alpha/4.0.0-alpha.2/${"9".repeat(64)}`;
  const contents = new Map([
    [
      "kungfu-installer-publication.json",
      Buffer.from('{"publication":true}\n'),
    ],
    ["kungfu-installer-channel-index.json", Buffer.from('{"channel":true}\n')],
    ["kungfu-installer-trusted-keys.json", Buffer.from('{"keys":true}\n')],
    ["kungfu-install.sh", Buffer.from("#!/bin/sh\nexit 0\n")],
    ["kungfu-install.ps1", Buffer.from("exit 0\r\n")],
  ]);
  const metadata = [
    [
      "installer-publication.json",
      "publication-manifest",
      "kungfu-installer-publication.json",
    ],
    [
      "channel-index.json",
      "signed-channel-index",
      "kungfu-installer-channel-index.json",
    ],
    [
      "trusted-keys.json",
      "public-trust-anchors",
      "kungfu-installer-trusted-keys.json",
    ],
    ["install.sh", "friendly-installer", "kungfu-install.sh"],
    ["install.ps1", "friendly-installer", "kungfu-install.ps1"],
    [`${immutablePath}/install.sh`, "immutable-installer", "kungfu-install.sh"],
    [
      `${immutablePath}/install.ps1`,
      "immutable-installer",
      "kungfu-install.ps1",
    ],
  ];
  const assets = metadata.map(([assetPath, role, releaseAsset]) => {
    const bytes = contents.get(releaseAsset);
    return {
      path: assetPath,
      role,
      contentType: assetPath.endsWith(".json")
        ? "application/json; charset=utf-8"
        : assetPath.endsWith(".sh")
          ? "text/x-shellscript; charset=utf-8"
          : "text/plain; charset=utf-8",
      size: bytes.length,
      digest: digest(bytes),
      releaseAsset,
      releaseUrl: `${releaseBase}/${releaseAsset}`,
    };
  });
  const cachePolicy = {
    friendly: "public,max-age=300,must-revalidate",
    immutable: "public,max-age=31536000,immutable",
  };
  const unsigned = {
    schema: "kungfu.installer-publication-bundle/v1",
    identity: {
      channel: "alpha",
      version: "4.0.0-alpha.2",
      sourceCommit,
      releaseSha: RELEASE_SHA,
      releaseTag: "v4.0.0-alpha.2",
      channelPayloadRoot: `sha256:${"3".repeat(64)}`,
      channelFileDigest: `sha256:${"5".repeat(64)}`,
      releasePassport: { root: `sha256:${"4".repeat(64)}` },
    },
    package: { name: "@kungfu-tech/site", version: "4.0.0-alpha.1" },
    distribution: {
      repository: "kungfu-systems/kungfu",
      releaseBaseUrl: releaseBase,
      manifestAsset: "kungfu-installer-publication-bundle.json",
    },
    routes: {
      friendly: {
        "install.sh": "https://kungfu.tech/install.sh",
        "install.ps1": "https://kungfu.tech/install.ps1",
      },
      immutablePath,
    },
    cachePolicy,
    assets,
  };
  const bundleRoot = digest(Buffer.from(JSON.stringify(canonical(unsigned))));
  const manifest = { ...unsigned, bundleRoot };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const evidence = {
    ...fixture(),
    identity: {
      ...fixture().identity,
      candidateSourceSha: CANDIDATE_SOURCE_SHA,
    },
    publication: {
      url: `${releaseBase}/kungfu-installer-publication-bundle.json`,
      payloadRoot: bundleRoot,
      installerBundle: {
        schema: unsigned.schema,
        bundleRoot,
        manifestDigest: digest(manifestBytes),
        sourceCommit,
        channel: "alpha",
        channelPayloadRoot: unsigned.identity.channelPayloadRoot,
        channelFileDigest: unsigned.identity.channelFileDigest,
        releasePassport: unsigned.identity.releasePassport,
        cachePolicy,
        assets,
      },
    },
    readback: {
      status: "passed",
      url: `${releaseBase}/kungfu-installer-publication-bundle.json`,
      payloadRoot: bundleRoot,
      manifestDigest: digest(manifestBytes),
    },
    siteHandoff: {
      state: "deferred-to-site-owned-consumer",
      productionAvailable: false,
      requiredBundleRoot: bundleRoot,
    },
  };
  return { evidence, manifestBytes, contents };
}

test("publication commit evidence binds exact public read-back", () => {
  const result = validatePublicationCommitEvidence(fixture(), expected);
  assert.equal(result.status, "passed");
  assert.equal(result.payloadRoot, ROOT);
});

test("publication commit evidence rejects stale or unrooted authority", () => {
  const stale = fixture();
  stale.readback.payloadRoot = `sha256:${"b".repeat(64)}`;
  assert.throws(
    () => validatePublicationCommitEvidence(stale, expected),
    /exact payload root/,
  );

  const drifted = fixture();
  drifted.identity.releaseSha = "3".repeat(40);
  assert.throws(
    () => validatePublicationCommitEvidence(drifted, expected),
    /releaseSha mismatch/,
  );

  const unrecoverable = fixture();
  unrecoverable.recovery.rollbackReference = "";
  assert.throws(
    () => validatePublicationCommitEvidence(unrecoverable, expected),
    /rollbackReference is required/,
  );
});

test("installer publication bundle is independently sealed from public bytes", async () => {
  const value = installerFixture();
  const result = validatePublicationCommitEvidence(value.evidence, expected);
  const fetchImpl = async (url) => {
    const assetName = new URL(url).pathname.split("/").at(-1);
    const bytes =
      assetName === "kungfu-installer-publication-bundle.json"
        ? value.manifestBytes
        : value.contents.get(assetName);
    return {
      status: bytes ? 200 : 404,
      async arrayBuffer() {
        return bytes || Buffer.alloc(0);
      },
    };
  };
  const seal = await verifyInstallerBundleReadback(result, fetchImpl);
  assert.equal(
    seal.schema,
    "kungfu-buildchain-installer-publication-bundle-seal/v1",
  );
  assert.equal(seal.bundleRoot, value.evidence.publication.payloadRoot);
  assert.equal(seal.sourceCommit, CANDIDATE_SOURCE_SHA);
  assert.match(seal.sealRoot, /^sha256:[a-f0-9]{64}$/);
});

test("installer publication read-back follows bounded GitHub release redirects", async () => {
  const value = installerFixture();
  const result = validatePublicationCommitEvidence(value.evidence, expected);
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const parsed = new URL(url);
    const assetName = parsed.pathname.split("/").at(-1);
    if (parsed.hostname === "github.com") {
      return {
        status: 302,
        headers: {
          get(name) {
            return name.toLowerCase() === "location"
              ? `https://release-assets.githubusercontent.com/${assetName}?token=fixture`
              : null;
          },
        },
      };
    }
    const bytes =
      assetName === "kungfu-installer-publication-bundle.json"
        ? value.manifestBytes
        : value.contents.get(assetName);
    return {
      status: bytes ? 200 : 404,
      async arrayBuffer() {
        return bytes || Buffer.alloc(0);
      },
    };
  };

  const seal = await verifyInstallerBundleReadback(result, fetchImpl);
  assert.equal(seal.bundleRoot, value.evidence.publication.payloadRoot);
  assert.ok(
    requests.some(
      ({ url }) =>
        new URL(url).hostname === "release-assets.githubusercontent.com",
    ),
  );
  assert.ok(requests.every(({ options }) => options.redirect === "manual"));
});

test("installer publication read-back rejects redirects outside GitHub storage", async () => {
  const value = installerFixture();
  const result = validatePublicationCommitEvidence(value.evidence, expected);
  const fetchImpl = async () => ({
    status: 302,
    headers: {
      get(name) {
        return name.toLowerCase() === "location"
          ? "https://example.com/untrusted"
          : null;
      },
    },
  });

  await assert.rejects(
    verifyInstallerBundleReadback(result, fetchImpl),
    /outside trusted GitHub release storage/,
  );
});

test("installer publication bundle rejects an unbound candidate source", () => {
  const value = installerFixture();
  delete value.evidence.identity.candidateSourceSha;
  assert.throws(
    () => validatePublicationCommitEvidence(value.evidence, expected),
    /installer bundle release identity mismatch/,
  );
});

test("sealed recovery binds installer bundle to its distinct candidate source", () => {
  const value = installerFixture();
  const recoveryExpected = {
    ...expected,
    candidateSourceSha: CANDIDATE_SOURCE_SHA,
  };
  const result = validatePublicationCommitEvidence(
    value.evidence,
    recoveryExpected,
  );
  assert.equal(result.identity.sourceSha, SOURCE_SHA);
  assert.equal(result.identity.candidateSourceSha, CANDIDATE_SOURCE_SHA);
  assert.equal(result.installerBundle.sourceCommit, CANDIDATE_SOURCE_SHA);

  assert.throws(
    () =>
      validatePublicationCommitEvidence(value.evidence, {
        ...expected,
        candidateSourceSha: "4".repeat(40),
      }),
    /candidateSourceSha mismatch/,
  );
});

test("installer publication bundle rejects transport and read-back drift", async () => {
  const invalid = installerFixture();
  invalid.evidence.publication.installerBundle.assets[0].contentType =
    "text/plain";
  assert.throws(
    () => validatePublicationCommitEvidence(invalid.evidence, expected),
    /transport metadata/,
  );

  const drifted = installerFixture();
  const result = validatePublicationCommitEvidence(drifted.evidence, expected);
  const fetchImpl = async (url) => ({
    status: 200,
    async arrayBuffer() {
      return url.endsWith("kungfu-installer-publication-bundle.json")
        ? drifted.manifestBytes
        : Buffer.from("tampered\n");
    },
  });
  await assert.rejects(
    verifyInstallerBundleReadback(result, fetchImpl),
    /asset drifted/,
  );
});
