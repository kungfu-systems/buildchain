import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyReleasePassport } from "../../packages/core/release-passport.js";

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function bytes(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data || "");
}

async function downloadAsset({ octokit, owner, repo, asset }) {
  if (typeof octokit.rest.repos.getReleaseAsset !== "function") {
    throw new Error(`cannot verify existing GitHub Release asset '${asset.name}': getReleaseAsset is unavailable`);
  }
  const response = await octokit.rest.repos.getReleaseAsset({
    owner,
    repo,
    asset_id: asset.id,
    headers: { accept: "application/octet-stream" },
  });
  return bytes(response.data);
}

async function assetDigest({ octokit, owner, repo, asset }) {
  const declared = String(asset.digest || "").match(/^sha256:([0-9a-f]{64})$/i);
  if (declared) return declared[1].toLowerCase();
  return sha256(await downloadAsset({ octokit, owner, repo, asset }));
}

function uniqueAssets(assets = []) {
  const byName = new Map();
  for (const asset of assets) {
    if (!asset?.name || path.basename(asset.name) !== asset.name) {
      throw new Error(`existing GitHub Release contains an unsafe asset name '${asset?.name || ""}'`);
    }
    if (byName.has(asset.name)) {
      throw new Error(`immutable GitHub Release asset collision: '${asset.name}' exists more than once`);
    }
    byName.set(asset.name, asset);
  }
  return byName;
}

function uniqueLocalAssets(assetPaths = []) {
  const byName = new Map();
  for (const assetPath of assetPaths) {
    if (!assetPath || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
      throw new Error(`github-release=true requires a declared GitHub Release artifact, got '${assetPath || ""}'`);
    }
    const name = path.basename(assetPath);
    const existing = byName.get(name);
    if (existing && sha256(fs.readFileSync(existing)) !== sha256(fs.readFileSync(assetPath))) {
      throw new Error(`github-release=true found duplicate asset basename '${name}' with conflicting content`);
    }
    if (!existing) byName.set(name, assetPath);
  }
  return byName;
}

async function stagePublicPassport({ octokit, owner, repo, remoteAssets, localFallbacks, directory }) {
  for (const asset of remoteAssets.values()) {
    if (!asset.name.endsWith(".json")) continue;
    const data = await downloadAsset({ octokit, owner, repo, asset });
    fs.writeFileSync(path.join(directory, asset.name), data);
  }
  for (const [name, assetPath] of localFallbacks) {
    if (remoteAssets.has(name)) continue;
    fs.copyFileSync(assetPath, path.join(directory, name));
  }
  return path.join(directory, "buildchain.release.json");
}

function assertPassportIdentity({ passport, owner, repo, tag, target, channel, targetRef }) {
  const publicTag = passport.release?.publicTag || passport.release?.tag || "";
  if (publicTag !== tag) {
    throw new Error(`existing GitHub Release Passport tag mismatch: expected ${tag}, got ${publicTag || "<empty>"}`);
  }
  if (passport.product?.repository && passport.product.repository !== `${owner}/${repo}`) {
    throw new Error(`existing GitHub Release Passport repository mismatch: expected ${owner}/${repo}, got ${passport.product.repository}`);
  }
  if (channel && passport.release?.channel !== channel) {
    throw new Error(`existing GitHub Release Passport channel mismatch: expected ${channel}, got ${passport.release?.channel || "<empty>"}`);
  }
  if (targetRef && passport.release?.targetRef !== targetRef) {
    throw new Error(`existing GitHub Release Passport target mismatch: expected ${targetRef}, got ${passport.release?.targetRef || "<empty>"}`);
  }
  const releaseShas = [
    passport.release?.releaseSha,
    passport.release?.releaseMaterialSha,
    passport.release?.sourceSha,
  ].filter(Boolean);
  if (target && !releaseShas.includes(target)) {
    throw new Error(`existing GitHub Release Passport source mismatch: expected ${target}, got ${releaseShas.join(", ") || "<empty>"}`);
  }
}

async function verifyPublicPassport({ octokit, owner, repo, remoteAssets, localFallbacks, expected, verifyPassport }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-public-release-"));
  try {
    const passportPath = await stagePublicPassport({ octokit, owner, repo, remoteAssets, localFallbacks, directory });
    const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
    // A complete public Release is an immutable historical snapshot. Re-check
    // freshness at the snapshot cut recorded by the Passport; using wall-clock
    // time would make every otherwise valid release fail recovery after its
    // bounded gate evidence expires.
    const report = await verifyPassport({
      passportLocation: passportPath,
      checkedAt: passport.generatedAt || undefined,
    });
    if (report?.ok !== true) {
      const issues = (report?.issues || [])
        .map((issue) => `${issue.code || "unknown"}: ${issue.message || "verification failed"}`)
        .join("; ");
      throw new Error(`existing GitHub Release Passport verification failed${issues ? `: ${issues}` : ""}`);
    }
    assertPassportIdentity({ passport, owner, repo, ...expected });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function reconcilePayload({ octokit, owner, repo, releaseId, remoteAssets, assetPath }) {
  if (!assetPath || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
    throw new Error(`github-release=true requires a declared GitHub Release artifact, got '${assetPath || ""}'`);
  }
  const name = path.basename(assetPath);
  const data = fs.readFileSync(assetPath);
  const localDigest = sha256(data);
  const candidateNames = [...new Set([name, name.replaceAll(" ", ".")])];
  const existingCandidates = candidateNames
    .map((candidateName) => remoteAssets.get(candidateName))
    .filter(Boolean);
  if (existingCandidates.length > 1) {
    throw new Error(
      `immutable GitHub Release product payload collision: '${name}' matches more than one remote asset after GitHub filename normalization`,
    );
  }
  const existing = existingCandidates[0];
  if (!existing) {
    await octokit.rest.repos.uploadReleaseAsset({ owner, repo, release_id: releaseId, name, data });
    return { action: "uploaded", name, digest: `sha256:${localDigest}` };
  }
  const remoteDigest = await assetDigest({ octokit, owner, repo, asset: existing });
  if (localDigest !== remoteDigest) {
    throw new Error(
      `immutable GitHub Release product payload collision: '${name}' already exists with sha256:${remoteDigest}, refusing sha256:${localDigest}`,
    );
  }
  return { action: "preserved", name, digest: `sha256:${localDigest}` };
}

export async function reuseCompleteGitHubReleaseEvidence({
  octokit,
  owner,
  repo,
  release,
  tag,
  target,
  channel = "",
  targetRef = "",
  evidenceAssetPaths = [],
  additionalAssetPaths = [],
  verifyPassport = verifyReleasePassport,
} = {}) {
  const listed = await octokit.rest.repos.listReleaseAssets({
    owner,
    repo,
    release_id: release.id,
    per_page: 100,
  });
  const remoteAssets = uniqueAssets(listed.data || []);
  const initialRemoteAssetCount = remoteAssets.size;
  if (!remoteAssets.has("buildchain.release.json")) {
    throw new Error("complete recovery requires the existing GitHub Release asset 'buildchain.release.json'");
  }
  const localEvidence = uniqueLocalAssets(evidenceAssetPaths);
  await verifyPublicPassport({
    octokit,
    owner,
    repo,
    remoteAssets,
    localFallbacks: localEvidence,
    expected: { tag, target, channel, targetRef },
    verifyPassport,
  });
  const evidenceResults = [];
  for (const [name, assetPath] of localEvidence) {
    if (remoteAssets.has(name)) {
      evidenceResults.push({ action: "preserved", name });
      continue;
    }
    const data = fs.readFileSync(assetPath);
    const uploaded = await octokit.rest.repos.uploadReleaseAsset({
      owner,
      repo,
      release_id: release.id,
      name,
      data,
    });
    remoteAssets.set(name, uploaded?.data || { name, digest: `sha256:${sha256(data)}` });
    evidenceResults.push({ action: "uploaded", name, digest: `sha256:${sha256(data)}` });
  }
  const payloadResults = [];
  for (const assetPath of additionalAssetPaths) {
    payloadResults.push(await reconcilePayload({
      octokit,
      owner,
      repo,
      releaseId: release.id,
      remoteAssets,
      assetPath,
    }));
  }
  const uploadedAssetCount = [...evidenceResults, ...payloadResults]
    .filter((asset) => asset.action === "uploaded").length;
  return {
    action: "reused",
    url: release.html_url || "",
    tag,
    assetCount: initialRemoteAssetCount + uploadedAssetCount,
    uploadedAssetCount,
    preservedAssetCount: initialRemoteAssetCount,
    passportVerified: true,
  };
}
