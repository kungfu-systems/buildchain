#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const INSTALLER_PUBLICATION_SCHEMA =
  "kungfu.bootstrap-installer-publication/v1";
export const INSTALLER_EVIDENCE_SCHEMA =
  "kungfu-buildchain-installer-publication-evidence/v1";

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

function root(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requireRoot(value, label) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value || "")) {
    throw new Error(`${label} must be a sha256 root`);
  }
}

function publicHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be public HTTPS`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be public HTTPS`);
  }
  return url;
}

function safeRelative(value, label) {
  const normalized = String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.split("/").includes("..") ||
    path.isAbsolute(normalized)
  ) {
    throw new Error(`${label} is not a safe relative path`);
  }
  return normalized;
}

function readAsset(artifactRoot, relativePath, expected) {
  const safePath = safeRelative(relativePath, "installer asset path");
  const absolute = path.resolve(artifactRoot, safePath);
  const rootPath = path.resolve(artifactRoot);
  if (!absolute.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`installer asset escapes artifact root: ${safePath}`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `installer asset must be a regular non-symlink file: ${safePath}`,
    );
  }
  const bytes = fs.readFileSync(absolute);
  const observed = {
    path: safePath,
    size: bytes.length,
    digest: sha256(bytes),
  };
  if (observed.size !== expected.size || observed.digest !== expected.digest) {
    throw new Error(
      `installer asset differs from publication metadata: ${safePath}`,
    );
  }
  return observed;
}

export function validateInstallerPublication({ publication, artifactRoot }) {
  if (publication?.schema !== INSTALLER_PUBLICATION_SCHEMA) {
    throw new Error("unsupported installer publication schema");
  }
  if (!["alpha", "stable"].includes(publication.channel)) {
    throw new Error("installer publication channel is invalid");
  }
  requireRoot(publication.channelPayloadRoot, "channelPayloadRoot");
  requireRoot(publication.channelFileDigest, "channelFileDigest");
  requireRoot(publication.releasePassport?.root, "releasePassport.root");
  publicHttpsUrl(publication.channelUrl, "channelUrl");
  if (!/^[a-f0-9]{40}$/.test(publication.sourceCommit || "")) {
    throw new Error("installer publication sourceCommit is invalid");
  }
  const immutablePath = safeRelative(
    publication.immutablePath,
    "immutablePath",
  );
  if (publication.installerVersion !== "v1") {
    throw new Error("installer publication version is unsupported");
  }
  if (!immutablePath.startsWith("installers/")) {
    throw new Error("installer immutablePath must stay below installers/");
  }
  if (!publication.releasePassport?.ref) {
    throw new Error("installer publication releasePassport.ref is required");
  }
  if (!Array.isArray(publication.entries) || publication.entries.length === 0) {
    throw new Error("installer publication has no platform entries");
  }
  const identities = new Set();
  for (const entry of publication.entries) {
    const identity = `${entry.platform}/${entry.architecture}`;
    if (identities.has(identity))
      throw new Error(`duplicate installer target: ${identity}`);
    identities.add(identity);
    requireRoot(entry.manifestRoot, `${identity}.manifestRoot`);
    requireRoot(entry.artifactRoot, `${identity}.artifactRoot`);
    requireRoot(entry.artifactDigest, `${identity}.artifactDigest`);
    publicHttpsUrl(entry.artifactUrl, `${identity}.artifactUrl`);
    if (
      entry.sourceCommit !== publication.sourceCommit ||
      !entry.version ||
      !Number.isSafeInteger(entry.artifactSize) ||
      entry.artifactSize < 1 ||
      !entry.artifactSignature
    ) {
      throw new Error(`installer target source mismatch: ${identity}`);
    }
  }
  if (!Array.isArray(publication.assets) || publication.assets.length !== 2) {
    throw new Error(
      "installer publication must bind install.sh and install.ps1",
    );
  }
  const expectedNames = new Set(["install.sh", "install.ps1"]);
  const assets = publication.assets
    .map((asset) => {
      if (!expectedNames.delete(asset.name)) {
        throw new Error(
          `unexpected or duplicate installer asset: ${asset.name}`,
        );
      }
      requireRoot(asset.digest, `${asset.name}.digest`);
      if (!Number.isSafeInteger(asset.size) || asset.size < 1) {
        throw new Error(`${asset.name}.size is invalid`);
      }
      const expectedContentType =
        asset.name === "install.sh"
          ? "text/x-shellscript; charset=utf-8"
          : "text/plain; charset=utf-8";
      if (asset.contentType !== expectedContentType) {
        throw new Error(`${asset.name}.contentType is invalid`);
      }
      const immutable = readAsset(
        artifactRoot,
        `${immutablePath}/${asset.name}`,
        asset,
      );
      const friendly = readAsset(artifactRoot, asset.name, asset);
      const friendlyUrl = publicHttpsUrl(
        asset.friendlyUrl,
        `${asset.name}.friendlyUrl`,
      );
      const immutableUrl = publicHttpsUrl(
        asset.immutableUrl,
        `${asset.name}.immutableUrl`,
      );
      if (
        friendlyUrl.origin !== immutableUrl.origin ||
        friendlyUrl.pathname !== `/${asset.name}` ||
        immutableUrl.pathname !== `/${immutablePath}/${asset.name}`
      ) {
        throw new Error(
          `installer asset URL mapping is invalid: ${asset.name}`,
        );
      }
      return {
        name: asset.name,
        contentType: asset.contentType,
        size: asset.size,
        digest: asset.digest,
        immutable,
        friendly,
        immutableUrl: immutableUrl.href,
        friendlyUrl: friendlyUrl.href,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const evidence = {
    schema: INSTALLER_EVIDENCE_SCHEMA,
    state: "verified",
    installerVersion: publication.installerVersion,
    channel: publication.channel,
    sourceCommit: publication.sourceCommit,
    channelPayloadRoot: publication.channelPayloadRoot,
    channelFileDigest: publication.channelFileDigest,
    releasePassport: publication.releasePassport,
    immutablePath,
    entries: publication.entries,
    assets,
  };
  return { ...evidence, evidenceRoot: root(evidence) };
}

function cacheMaxAge(value) {
  const match = /(?:^|,)\s*max-age=([0-9]+)(?:,|$)/i.exec(value || "");
  return match ? Number(match[1]) : null;
}

async function readPublicAsset(url, fetchImpl) {
  const response = await fetchImpl(url, {
    redirect: "manual",
    headers: { accept: "text/plain, application/octet-stream;q=0.9" },
  });
  if (response.status !== 200) {
    throw new Error(
      `installer public read-back failed (${response.status}): ${url}`,
    );
  }
  return {
    url,
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") || "",
    cacheControl: response.headers.get("cache-control") || "",
    etag: response.headers.get("etag") || "",
    versionId: response.headers.get("x-amz-version-id") || "",
  };
}

export async function verifyInstallerPublicReadback({
  publication,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function")
    throw new Error("fetch implementation is required");
  const observations = [];
  for (const asset of publication.assets || []) {
    for (const [route, url] of [
      ["friendly", asset.friendlyUrl],
      ["immutable", asset.immutableUrl],
    ]) {
      const observed = await readPublicAsset(url, fetchImpl);
      const digest = sha256(observed.bytes);
      if (observed.bytes.length !== asset.size || digest !== asset.digest) {
        throw new Error(`installer public bytes drifted: ${url}`);
      }
      const contentType = observed.contentType.toLowerCase();
      if (
        !contentType.startsWith("text/plain") &&
        !contentType.startsWith("text/x-shellscript") &&
        !contentType.startsWith("application/octet-stream")
      ) {
        throw new Error(`installer public content type is unsafe: ${url}`);
      }
      const maxAge = cacheMaxAge(observed.cacheControl);
      if (
        route === "friendly" &&
        (maxAge === null ||
          maxAge > 300 ||
          !/must-revalidate/i.test(observed.cacheControl))
      ) {
        throw new Error(
          `friendly installer cache policy is not revalidated: ${url}`,
        );
      }
      if (
        route === "immutable" &&
        (maxAge === null ||
          maxAge < 31_536_000 ||
          !/immutable/i.test(observed.cacheControl))
      ) {
        throw new Error(
          `immutable installer cache policy is not immutable: ${url}`,
        );
      }
      observations.push({
        name: asset.name,
        route,
        url,
        size: observed.bytes.length,
        digest,
        contentType: observed.contentType,
        cacheControl: observed.cacheControl,
        etag: observed.etag,
        versionId: observed.versionId,
      });
    }
  }
  const evidence = {
    schema: INSTALLER_EVIDENCE_SCHEMA,
    state: "public-readback-verified",
    sourceCommit: publication.sourceCommit,
    channelPayloadRoot: publication.channelPayloadRoot,
    releasePassport: publication.releasePassport,
    observations,
  };
  return { ...evidence, evidenceRoot: root(evidence) };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--manifest") options.manifest = args[++index];
    else if (value === "--artifact-root") options.artifactRoot = args[++index];
    else if (value === "--public-readback") options.publicReadback = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!options.manifest) throw new Error("--manifest is required");
  if (!options.publicReadback && !options.artifactRoot) {
    throw new Error("--artifact-root is required without --public-readback");
  }
  return options;
}

async function main(args) {
  const options = parseArgs(args);
  const publication = JSON.parse(
    fs.readFileSync(path.resolve(options.manifest), "utf8"),
  );
  const evidence = options.publicReadback
    ? await verifyInstallerPublicReadback({ publication })
    : validateInstallerPublication({
        publication,
        artifactRoot: path.resolve(options.artifactRoot),
      });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`installer-publication: ${error.message}\n`);
    process.exitCode = 1;
  });
}
