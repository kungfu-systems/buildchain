import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function readEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

const version = readEnv("BUILDCHAIN_VERSION");
const channel = readEnv("BUILDCHAIN_CHANNEL");
const sourceSha = readEnv("BUILDCHAIN_SOURCE_SHA");
const releaseSha = readEnv("BUILDCHAIN_RELEASE_SHA");
const targetRef = readEnv("BUILDCHAIN_TARGET_REF");
const evidencePath = readEnv("BUILDCHAIN_PUBLISH_EVIDENCE");
const releaseMaterialSha = process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA || releaseSha;
const publishToolingSha = process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA || releaseSha;

const artifacts = [
  {
    group: "node",
    kind: "npm",
    name: "@kungfu-systems/publish-transaction-shaped",
    ref: version,
    digest: digest(`npm:${version}:${releaseMaterialSha}`),
  },
  {
    group: "image",
    kind: "oci",
    name: "ghcr.io/kungfu-systems/publish-transaction-shaped",
    ref: version,
    digest: digest(`oci:${version}:${releaseMaterialSha}`),
  },
  {
    group: "binary",
    kind: "archive",
    name: "publish-transaction-shaped-darwin-arm64",
    ref: version,
    digest: digest(`archive:${version}:${releaseMaterialSha}`),
  },
];

fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      schema: 1,
      version,
      channel,
      source_sha: sourceSha,
      release_sha: releaseSha,
      target_ref: targetRef,
      release_material_sha: releaseMaterialSha,
      publish_tooling_sha: publishToolingSha,
      artifacts,
    },
    null,
    2,
  )}\n`,
);

console.log(`publish_evidence=${evidencePath}`);
