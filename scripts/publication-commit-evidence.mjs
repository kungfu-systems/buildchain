#!/usr/bin/env node

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA = "kungfu-buildchain-publication-commit-evidence/v1";
const INSTALLER_BUNDLE_SCHEMA = "kungfu.installer-publication-bundle/v1";
const RELEASE_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RELEASE_REDIRECT_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function sha256Root(value, label) {
  const normalized = requiredString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a lowercase sha256 root`);
  }
  return normalized;
}

function exactSha(value, label) {
  const normalized = requiredString(value, label);
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be an exact Git SHA`);
  }
  return normalized;
}

function publicHttps(value, label) {
  const normalized = requiredString(value, label);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a public HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${label} must be a public HTTPS URL without credentials, query, or fragment`,
    );
  }
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function semanticRoot(value) {
  return digest(Buffer.from(JSON.stringify(canonical(value))));
}

function expectedContentType(assetPath) {
  if (assetPath.endsWith(".json")) return "application/json; charset=utf-8";
  if (assetPath.endsWith(".sh")) return "text/x-shellscript; charset=utf-8";
  if (assetPath.endsWith(".ps1")) return "text/plain; charset=utf-8";
  throw new Error(`installer bundle asset type is unsupported: ${assetPath}`);
}

function validateInstallerBundle(evidence, expected) {
  const bundle = evidence.publication?.installerBundle;
  if (!bundle) return null;
  if (bundle.schema !== INSTALLER_BUNDLE_SCHEMA) {
    throw new Error(
      `installer bundle schema must be ${INSTALLER_BUNDLE_SCHEMA}`,
    );
  }
  const bundleRoot = sha256Root(
    bundle.bundleRoot,
    "installerBundle.bundleRoot",
  );
  if (
    bundleRoot !== evidence.publication.payloadRoot ||
    bundleRoot !== evidence.readback?.payloadRoot
  ) {
    throw new Error(
      "installer bundle root must be the publication payload root",
    );
  }
  if (
    exactSha(bundle.sourceCommit, "installerBundle.sourceCommit") !==
      expected.candidateSourceSha ||
    !["alpha", "stable"].includes(bundle.channel)
  ) {
    throw new Error("installer bundle release identity mismatch");
  }
  sha256Root(bundle.channelPayloadRoot, "installerBundle.channelPayloadRoot");
  sha256Root(bundle.channelFileDigest, "installerBundle.channelFileDigest");
  sha256Root(
    bundle.releasePassport?.root,
    "installerBundle.releasePassport.root",
  );
  sha256Root(bundle.manifestDigest, "installerBundle.manifestDigest");
  if (
    evidence.readback?.manifestDigest !== bundle.manifestDigest ||
    !Array.isArray(bundle.assets) ||
    bundle.assets.length !== 7
  ) {
    throw new Error("installer bundle read-back or asset set is incomplete");
  }
  const paths = new Set();
  const topLevel = new Set([
    "installer-publication.json",
    "channel-index.json",
    "trusted-keys.json",
    "install.sh",
    "install.ps1",
  ]);
  const expectedRoles = new Map([
    ["installer-publication.json", "publication-manifest"],
    ["channel-index.json", "signed-channel-index"],
    ["trusted-keys.json", "public-trust-anchors"],
    ["install.sh", "friendly-installer"],
    ["install.ps1", "friendly-installer"],
  ]);
  const immutableDirectories = new Set();
  let immutableShell = 0;
  let immutablePowerShell = 0;
  const releaseBaseUrl =
    `https://github.com/kungfu-systems/kungfu/releases/download/` +
    expected.releaseTag;
  for (const asset of bundle.assets) {
    const assetPath = requiredString(
      asset.path,
      "installer bundle asset path",
    ).replaceAll("\\", "/");
    if (
      assetPath.startsWith("/") ||
      assetPath.endsWith("/") ||
      assetPath.split("/").some((part) => part === "" || part === "..") ||
      paths.has(assetPath)
    ) {
      throw new Error(
        `unsafe or duplicate installer bundle asset: ${assetPath}`,
      );
    }
    paths.add(assetPath);
    topLevel.delete(assetPath);
    if (assetPath.includes("/") && assetPath.endsWith("/install.sh")) {
      immutableShell += 1;
      immutableDirectories.add(path.posix.dirname(assetPath));
    }
    if (assetPath.includes("/") && assetPath.endsWith("/install.ps1")) {
      immutablePowerShell += 1;
      immutableDirectories.add(path.posix.dirname(assetPath));
    }
    if (!Number.isSafeInteger(asset.size) || asset.size < 1) {
      throw new Error(`installer bundle asset size is invalid: ${assetPath}`);
    }
    sha256Root(asset.digest, `installer bundle asset digest: ${assetPath}`);
    const releaseAsset = requiredString(
      asset.releaseAsset,
      `installer bundle release asset: ${assetPath}`,
    );
    if (
      asset.contentType !== expectedContentType(assetPath) ||
      publicHttps(
        asset.releaseUrl,
        `installer bundle asset URL: ${assetPath}`,
      ) !== `${releaseBaseUrl}/${releaseAsset}` ||
      !/^kungfu-[a-z0-9.-]+$/.test(releaseAsset)
    ) {
      throw new Error(
        `installer bundle asset transport metadata is invalid: ${assetPath}`,
      );
    }
    const expectedRole = assetPath.includes("/")
      ? "immutable-installer"
      : expectedRoles.get(assetPath);
    if (asset.role !== expectedRole) {
      throw new Error(`installer bundle asset role is invalid: ${assetPath}`);
    }
  }
  const immutableDirectory = [...immutableDirectories][0] || "";
  const immutableParts = immutableDirectory.split("/");
  if (
    topLevel.size !== 0 ||
    immutableShell !== 1 ||
    immutablePowerShell !== 1 ||
    immutableDirectories.size !== 1 ||
    immutableParts.length !== 5 ||
    immutableParts[0] !== "installers" ||
    immutableParts[1] !== "v1" ||
    immutableParts[2] !== bundle.channel ||
    immutableParts[3] !== expected.version ||
    !/^[a-f0-9]{64}$/.test(immutableParts[4])
  ) {
    throw new Error("installer bundle asset topology is incomplete");
  }
  if (
    bundle.cachePolicy?.friendly !== "public,max-age=300,must-revalidate" ||
    bundle.cachePolicy?.immutable !== "public,max-age=31536000,immutable"
  ) {
    throw new Error("installer bundle cache policy is invalid");
  }
  if (
    evidence.siteHandoff?.state !== "deferred-to-site-owned-consumer" ||
    evidence.siteHandoff?.productionAvailable !== false ||
    evidence.siteHandoff?.requiredBundleRoot !== bundleRoot
  ) {
    throw new Error("installer bundle site handoff must remain deferred");
  }
  return {
    schema: bundle.schema,
    bundleRoot,
    sourceCommit: bundle.sourceCommit,
    manifestDigest: bundle.manifestDigest,
    channel: bundle.channel,
    channelPayloadRoot: bundle.channelPayloadRoot,
    channelFileDigest: bundle.channelFileDigest,
    releasePassport: bundle.releasePassport,
    cachePolicy: bundle.cachePolicy,
    immutablePath: immutableDirectory,
    assets: bundle.assets,
  };
}
export function validatePublicationCommitEvidence(
  evidence,
  { version, sourceSha, candidateSourceSha, releaseSha, releaseTag } = {},
) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("publication commit evidence must be an object");
  }
  if (evidence.schema !== SCHEMA) {
    throw new Error(`publication commit evidence schema must be ${SCHEMA}`);
  }
  if (evidence.status !== "passed") {
    throw new Error("publication commit evidence status must be passed");
  }
  const identity = evidence.identity || {};
  const expected = {
    version: requiredString(version, "expected version"),
    sourceSha: exactSha(sourceSha, "expected sourceSha"),
    releaseSha: exactSha(releaseSha, "expected releaseSha"),
    releaseTag: requiredString(releaseTag, "expected releaseTag"),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (identity[field] !== value) {
      throw new Error(`publication commit evidence ${field} mismatch`);
    }
  }
  expected.candidateSourceSha = exactSha(
    candidateSourceSha ?? identity.candidateSourceSha ?? expected.sourceSha,
    "expected candidateSourceSha",
  );
  if (
    identity.candidateSourceSha !== undefined &&
    exactSha(identity.candidateSourceSha, "identity.candidateSourceSha") !==
      expected.candidateSourceSha
  ) {
    throw new Error("publication commit evidence candidateSourceSha mismatch");
  }
  const publicUrl = publicHttps(evidence.publication?.url, "publication.url");
  const payloadRoot = sha256Root(
    evidence.publication?.payloadRoot,
    "publication.payloadRoot",
  );
  if (
    evidence.readback?.status !== "passed" ||
    publicHttps(evidence.readback?.url, "readback.url") !== publicUrl ||
    sha256Root(evidence.readback?.payloadRoot, "readback.payloadRoot") !==
      payloadRoot
  ) {
    throw new Error(
      "publication read-back must pass at the canonical URL with the exact payload root",
    );
  }
  const previousAuthority = evidence.recovery?.previousAuthority;
  const rollbackReference = requiredString(
    evidence.recovery?.rollbackReference,
    "recovery.rollbackReference",
  );
  if (!["preserved", "none"].includes(previousAuthority)) {
    throw new Error(
      "publication recovery must preserve or explicitly declare no previous authority",
    );
  }
  const installerBundle = validateInstallerBundle(evidence, expected);
  return {
    schema: SCHEMA,
    status: "passed",
    publicUrl,
    payloadRoot,
    identity: expected,
    recovery: {
      previousAuthority,
      rollbackReference,
    },
    ...(installerBundle ? { installerBundle } : {}),
  };
}

export async function verifyInstallerBundleReadback(
  result,
  fetchImpl = globalThis.fetch,
) {
  const bundle = result.installerBundle;
  if (!bundle) return null;
  if (typeof fetchImpl !== "function") {
    throw new Error("installer bundle read-back requires fetch");
  }
  const fetchReleaseReadback = async (url, label) => {
    let current = url;
    for (let hop = 0; hop <= 3; hop += 1) {
      const response = await fetchImpl(current, {
        redirect: "manual",
        cache: "no-store",
      });
      if (response.status === 200) return response;
      if (!RELEASE_REDIRECT_STATUSES.has(response.status)) {
        throw new Error(`${label} failed: HTTP ${response.status}`);
      }
      if (hop === 3) {
        throw new Error(`${label} exceeded the bounded redirect limit`);
      }
      const location = response.headers?.get?.("location");
      if (!location) {
        throw new Error(`${label} redirect omitted Location`);
      }
      const redirect = new URL(location, current);
      if (
        redirect.protocol !== "https:" ||
        redirect.username ||
        redirect.password ||
        !RELEASE_REDIRECT_HOSTS.has(redirect.hostname) ||
        (redirect.hostname === "github.com" &&
          !redirect.pathname.startsWith(
            "/kungfu-systems/kungfu/releases/download/",
          ))
      ) {
        throw new Error(
          `${label} redirected outside trusted GitHub release storage`,
        );
      }
      current = redirect.href;
    }
    throw new Error(`${label} failed without a terminal response`);
  };
  const manifestResponse = await fetchReleaseReadback(
    result.publicUrl,
    "installer bundle manifest read-back",
  );
  const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
  if (digest(manifestBytes) !== bundle.manifestDigest) {
    throw new Error("installer bundle manifest digest mismatch");
  }
  const manifest = JSON.parse(manifestBytes);
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "bundleRoot"),
  );
  if (
    manifest.schema !== INSTALLER_BUNDLE_SCHEMA ||
    manifest.bundleRoot !== bundle.bundleRoot ||
    semanticRoot(unsigned) !== bundle.bundleRoot ||
    manifest.package?.name !== "@kungfu-tech/site" ||
    typeof manifest.package?.version !== "string" ||
    manifest.identity?.sourceCommit !== result.identity.candidateSourceSha ||
    manifest.identity?.releaseSha !== result.identity.releaseSha ||
    manifest.identity?.releaseTag !== result.identity.releaseTag ||
    manifest.identity?.version !== result.identity.version ||
    manifest.identity?.channel !== bundle.channel ||
    manifest.identity?.channelPayloadRoot !== bundle.channelPayloadRoot ||
    manifest.identity?.channelFileDigest !== bundle.channelFileDigest ||
    manifest.identity?.releasePassport?.root !== bundle.releasePassport.root ||
    manifest.distribution?.repository !== "kungfu-systems/kungfu" ||
    manifest.routes?.immutablePath !== bundle.immutablePath ||
    manifest.routes?.friendly?.["install.sh"] !==
      "https://kungfu.tech/install.sh" ||
    manifest.routes?.friendly?.["install.ps1"] !==
      "https://kungfu.tech/install.ps1" ||
    JSON.stringify(canonical(manifest.cachePolicy)) !==
      JSON.stringify(canonical(bundle.cachePolicy)) ||
    JSON.stringify(canonical(manifest.assets)) !==
      JSON.stringify(canonical(bundle.assets)) ||
    `${manifest.distribution?.releaseBaseUrl}/` +
      manifest.distribution?.manifestAsset !==
      result.publicUrl
  ) {
    throw new Error("installer bundle manifest root mismatch");
  }
  const observations = [];
  const byUrl = new Map();
  for (const asset of bundle.assets) {
    let observation = byUrl.get(asset.releaseUrl);
    if (!observation) {
      const response = await fetchReleaseReadback(
        asset.releaseUrl,
        "installer bundle asset read-back",
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      observation = {
        releaseUrl: asset.releaseUrl,
        size: bytes.length,
        digest: digest(bytes),
      };
      byUrl.set(asset.releaseUrl, observation);
    }
    if (
      observation.size !== asset.size ||
      observation.digest !== asset.digest
    ) {
      throw new Error(`installer bundle asset drifted: ${asset.path}`);
    }
    observations.push({ path: asset.path, ...observation });
  }
  const seal = {
    schema: "kungfu-buildchain-installer-publication-bundle-seal/v1",
    bundleRoot: bundle.bundleRoot,
    manifestDigest: bundle.manifestDigest,
    sourceCommit: result.identity.candidateSourceSha,
    releaseTag: result.identity.releaseTag,
    releasePassport: bundle.releasePassport,
    observations,
  };
  return { ...seal, sealRoot: semanticRoot(seal) };
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--evidence") options.evidence = args[++index];
    else if (value === "--version") options.version = args[++index];
    else if (value === "--source-sha") options.sourceSha = args[++index];
    else if (value === "--candidate-source-sha")
      options.candidateSourceSha = args[++index];
    else if (value === "--release-sha") options.releaseSha = args[++index];
    else if (value === "--release-tag") options.releaseTag = args[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  const evidencePath = path.resolve(
    requiredString(options.evidence, "--evidence"),
  );
  const result = validatePublicationCommitEvidence(
    JSON.parse(fs.readFileSync(evidencePath, "utf8")),
    options,
  );
  const installerBundleSeal = await verifyInstallerBundleReadback(result);
  process.stdout.write(
    `${JSON.stringify({
      ...result,
      ...(installerBundleSeal ? { installerBundleSeal } : {}),
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `publication commit evidence failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  });
}
