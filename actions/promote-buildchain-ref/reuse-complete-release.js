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

export async function downloadReleaseAsset({ octokit, owner, repo, asset }) {
  if (typeof octokit.rest.repos.getReleaseAsset !== "function") {
    throw new Error(`cannot verify existing GitHub Release asset '${asset.name}': getReleaseAsset is unavailable`);
  }
  const response = await octokit.rest.repos.getReleaseAsset({
    owner, repo, asset_id: asset.id, headers: { accept: "application/octet-stream" },
  });
  return bytes(response.data);
}

async function remoteDigest({ octokit, owner, repo, asset }) {
  const declared = String(asset.digest || "").match(/^sha256:([0-9a-f]{64})$/i);
  return declared ? declared[1].toLowerCase() : sha256(await downloadReleaseAsset({ octokit, owner, repo, asset }));
}

export function uniqueReleaseAssets(assets = []) {
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

export async function reconcileImmutableReleaseAssets({ octokit, owner, repo, releaseId, remoteAssets, assetPaths, rejectUnknown = false, collisionKind = "asset", uploadReleaseAsset = (request) => octokit.rest.repos.uploadReleaseAsset(request) }) {
  const local = new Map();
  for (const assetPath of assetPaths) {
    if (!assetPath || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
      throw new Error(`github-release=true requires a declared GitHub Release artifact, got '${assetPath || ""}'`);
    }
    const name = path.basename(assetPath);
    const data = fs.readFileSync(assetPath);
    if (local.has(name) && !local.get(name).data.equals(data)) throw new Error(`complete recovery repair found conflicting asset basename '${name}'`);
    local.set(name, { data, digest: sha256(data) });
  }
  if (rejectUnknown) for (const name of remoteAssets.keys()) {
    if (!local.has(name)) throw new Error(`complete recovery repair found undeclared existing GitHub Release asset '${name}'`);
  }
  const plan = [];
  for (const [name, value] of local) {
    const existing = remoteAssets.get(name);
    const digest = existing ? await remoteDigest({ octokit, owner, repo, asset: existing }) : "";
    if (existing && digest !== value.digest) {
      throw new Error(`immutable GitHub Release ${collisionKind} collision: '${name}' already exists with sha256:${digest}, refusing sha256:${value.digest}`);
    }
    plan.push({ action: existing ? "preserved" : "uploaded", name, ...value });
  }
  for (const asset of plan.filter((entry) => entry.action === "uploaded")) {
    await uploadReleaseAsset({ owner, repo, release_id: releaseId, name: asset.name, data: asset.data });
  }
  return plan;
}

async function stagePublicPassport({ octokit, owner, repo, remoteAssets, directory }) {
  for (const asset of remoteAssets.values()) {
    if (!asset.name.endsWith(".json")) continue;
    const data = await downloadReleaseAsset({ octokit, owner, repo, asset });
    fs.writeFileSync(path.join(directory, asset.name), data);
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

async function verifyPublicPassport({ octokit, owner, repo, remoteAssets, expected, verifyPassport }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-public-release-"));
  try {
    const passportPath = await stagePublicPassport({ octokit, owner, repo, remoteAssets, directory });
    const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
    const report = await verifyPassport({ passportLocation: passportPath });
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

async function verifyLocalPassport({
  passportPath,
  owner,
  repo,
  expected,
  verifyPassport,
}) {
  if (
    !passportPath ||
    !fs.existsSync(passportPath) ||
    !fs.statSync(passportPath).isFile()
  ) {
    throw new Error(
      "complete recovery repair requires a local 'buildchain.release.json'",
    );
  }
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyPassport({ passportLocation: passportPath });
  if (report?.ok !== true) {
    const issues = (report?.issues || [])
      .map(
        (issue) =>
          `${issue.code || "unknown"}: ${issue.message || "verification failed"}`,
      )
      .join("; ");
    throw new Error(
      `local recovery Passport verification failed${issues ? `: ${issues}` : ""}`,
    );
  }
  assertPassportIdentity({ passport, owner, repo, ...expected });
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
  additionalAssetPaths = [],
  repairAssetPaths = [],
  verifyPassport = verifyReleasePassport,
} = {}) {
  const listed = await octokit.rest.repos.listReleaseAssets({
    owner,
    repo,
    release_id: release.id,
    per_page: 100,
  });
  const remoteAssets = uniqueReleaseAssets(listed.data || []);
  if (!remoteAssets.has("buildchain.release.json")) {
    const localPassportPaths = repairAssetPaths.filter(
      (assetPath) => path.basename(assetPath) === "buildchain.release.json",
    );
    if (localPassportPaths.length !== 1) {
      throw new Error(
        "complete recovery requires the existing GitHub Release asset 'buildchain.release.json'",
      );
    }
    await verifyLocalPassport({
      passportPath: localPassportPaths[0],
      owner,
      repo,
      expected: { tag, target, channel, targetRef },
      verifyPassport,
    });
    const repaired = await reconcileImmutableReleaseAssets({
      octokit,
      owner,
      repo,
      releaseId: release.id,
      remoteAssets,
      assetPaths: repairAssetPaths,
      rejectUnknown: true,
      collisionKind: "evidence",
    });
    return {
      action: "repaired",
      url: release.html_url || "",
      tag,
      assetCount: repaired.length,
      uploadedAssetCount: repaired.filter((asset) => asset.action === "uploaded")
        .length,
      preservedAssetCount: repaired.filter(
        (asset) => asset.action === "preserved",
      ).length,
      passportVerified: true,
    };
  }
  await verifyPublicPassport({
    octokit,
    owner,
    repo,
    remoteAssets,
    expected: { tag, target, channel, targetRef },
    verifyPassport,
  });
  const payloadResults = await reconcileImmutableReleaseAssets({
    octokit, owner, repo, releaseId: release.id, remoteAssets, assetPaths: additionalAssetPaths,
    collisionKind: "product payload",
  });
  const uploadedAssetCount = payloadResults.filter((asset) => asset.action === "uploaded").length;
  return {
    action: "reused",
    url: release.html_url || "",
    tag,
    assetCount: remoteAssets.size + uploadedAssetCount,
    uploadedAssetCount,
    preservedAssetCount: remoteAssets.size,
    passportVerified: true,
  };
}
