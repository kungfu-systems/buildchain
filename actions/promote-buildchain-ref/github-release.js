import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  compileReleaseTailDeclaration,
  createReleaseTailAdapterSet,
  createReleaseTailTransaction,
  executeReleaseTailTransaction,
  readReleaseTailTransaction,
  releaseTailRoot,
  writeReleaseTailTransaction,
} from "../../packages/core/release-tail-provider-plane.js";
import {
  createGitHubReleaseAssetsAdapter,
  githubReleaseAssetsTargetRoot,
} from "../../packages/core/release-tail-provider-adapters.js";
import { ensureGitHubRelease } from "../../scripts/ensure-github-release.mjs";
import { reuseCompleteGitHubReleaseEvidence } from "./reuse-complete-release.js";

function assertFile(pathname, label) {
  if (
    !pathname ||
    !fs.existsSync(pathname) ||
    !fs.statSync(pathname).isFile()
  ) {
    throw new Error(
      `github-release=true requires ${label}, got '${pathname || ""}'`,
    );
  }
}

export function collectGitHubReleaseEvidenceAssets({
  publishEvidencePath = "",
  releasePassportPath = "",
  releasePassportOutputDir = "",
  additionalAssetPaths = [],
} = {}) {
  assertFile(publishEvidencePath, "a publish evidence file");
  assertFile(releasePassportPath, "buildchain.release.json");
  if (
    !releasePassportOutputDir ||
    !fs.existsSync(releasePassportOutputDir) ||
    !fs.statSync(releasePassportOutputDir).isDirectory()
  ) {
    throw new Error(
      `github-release=true requires a release passport output directory, got '${releasePassportOutputDir || ""}'`,
    );
  }
  const assets = [];
  const occupiedBasenames = new Map();
  const addAsset = (assetPath) => {
    const basename = path.basename(assetPath);
    const existing = occupiedBasenames.get(basename);
    if (existing) {
      if (sha256(fs.readFileSync(existing)) !== sha256(fs.readFileSync(assetPath))) {
        throw new Error(`github-release=true found duplicate asset basename '${basename}' with conflicting content`);
      }
      return;
    }
    occupiedBasenames.set(basename, assetPath);
    assets.push(assetPath);
  };
  addAsset(publishEvidencePath);
  for (const entry of fs.readdirSync(releasePassportOutputDir).sort()) {
    const candidate = path.join(releasePassportOutputDir, entry);
    if (fs.statSync(candidate).isFile()) addAsset(candidate);
  }
  if (assets.length < 2) {
    throw new Error(
      `github-release=true found no release passport assets under ${releasePassportOutputDir}`,
    );
  }
  for (const assetPath of additionalAssetPaths) {
    assertFile(assetPath, "a declared GitHub Release artifact");
    const basename = path.basename(assetPath);
    if (occupiedBasenames.has(basename)) {
      throw new Error(
        `github-release=true found duplicate asset basename '${basename}'`,
      );
    }
    addAsset(assetPath);
  }
  return assets;
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function releaseAssetRole(name, index) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `github-release-asset.${String(index + 1).padStart(2, "0")}.${slug || "asset"}`;
}

export function createDeclarativeGitHubReleasePlan({
  repository,
  sourceSha,
  version,
  tag,
  channel,
  assetPaths,
} = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(String(repository || ""))) {
    throw new Error("declarative GitHub Release requires owner/repository");
  }
  if (!/^[0-9a-f]{40}$/u.test(String(sourceSha || "").toLowerCase())) {
    throw new Error("declarative GitHub Release requires an exact source SHA");
  }
  if (!tag || !version || !["alpha", "release", "stable"].includes(channel)) {
    throw new Error(
      "declarative GitHub Release requires version, tag, and channel",
    );
  }
  const artifacts = [...assetPaths]
    .map((assetPath) => path.resolve(assetPath))
    .sort((left, right) =>
      path.basename(left).localeCompare(path.basename(right)),
    )
    .map((assetPath, index) => ({
      role: releaseAssetRole(path.basename(assetPath), index),
      name: path.basename(assetPath),
      path: assetPath,
      root: `sha256:${sha256(fs.readFileSync(assetPath))}`,
    }));
  const destination = {
    kind: "github-release",
    locator: `github-release:${repository}@${tag}`,
  };
  const subject = {
    repository,
    sourceSha: sourceSha.toLowerCase(),
    version,
    tag,
    channel,
  };
  const transactionRoot = releaseTailRoot({
    schema: "kungfu.buildchain.github-release-tail-identity/v1",
    subject,
    destination,
    artifacts: artifacts.map(({ role, name, root }) => ({ role, name, root })),
  });
  const targetRoot = githubReleaseAssetsTargetRoot({
    destination,
    artifacts: artifacts.map(({ role, name, root }) => ({ role, name, root })),
  });
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = {
    contract: "kungfu-buildchain-release-tail-capabilities",
    schemaVersion: 1,
    transactionPolicy: "buildchain.release-tail/v1",
    subject,
    capabilities: [
      {
        id: "artifact.publish",
        executor: "provider-adapter",
        adapter: "github-release-assets",
        artifactRoles: artifacts.map(({ role, root }) => ({ role, root })),
        destination,
        channelPolicy: {
          channel,
          tagPattern: `^${escapedTag}$`,
          authorityMove: "verified-ref",
        },
        activationPolicy: { mode: "none", environment: "none" },
        readbackPredicates: [
          {
            id: "github-release-assets-match-roots",
            kind: "provider-assets",
            expected:
              "all declared release assets are publicly readable at their sealed roots",
          },
        ],
        effect: {
          kind: "artifact-publication",
          schema: "kungfu.buildchain.release-tail.effect/v1",
        },
        observation: {
          kind: "artifact-publication-readback",
          schema: "kungfu.buildchain.release-tail.observation/v1",
        },
        receipt: {
          kind: "artifact-publication",
          schema: "kungfu.buildchain.release-tail.receipt/v1",
        },
        operationIdentity: {
          transactionRoot,
          capabilityId: "artifact.publish",
          subjectRoot: releaseTailRoot(subject),
          targetRoot,
          attemptKey: "artifact.publish/1",
        },
        idempotency: {
          scope: "subject-target",
          duplicate: "readback-before-retry",
        },
        retry: {
          class: "provider-transient",
          localAttempts: 2,
          exhausted: "repair-required",
        },
        evidenceRequirements: [
          "kungfu-buildchain-publish-evidence",
          "kungfu-buildchain-release-passport",
        ],
      },
    ],
  };
  return {
    artifacts,
    declaration,
    plan: compileReleaseTailDeclaration(declaration),
  };
}

function releaseAssetBytes(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(data || "");
}

async function existingReleaseAssetDigest({ octokit, owner, repo, asset }) {
  const declared = String(asset.digest || "").match(/^sha256:([0-9a-f]{64})$/i);
  if (declared) return declared[1].toLowerCase();
  if (typeof octokit.rest.repos.getReleaseAsset !== "function") {
    throw new Error(
      `GitHub Release asset '${asset.name}' has no sha256 digest and cannot be read for immutable comparison`,
    );
  }
  const response = await octokit.rest.repos.getReleaseAsset({
    owner,
    repo,
    asset_id: asset.id,
    headers: { accept: "application/octet-stream" },
  });
  return sha256(releaseAssetBytes(response.data));
}

async function uploadReleaseAssetImmutable({
  octokit,
  owner,
  repo,
  releaseId,
  assetPath,
}) {
  const name = path.basename(assetPath);
  const data = fs.readFileSync(assetPath);
  const digest = sha256(data);
  const existing = await octokit.rest.repos.listReleaseAssets({
    owner,
    repo,
    release_id: releaseId,
    per_page: 100,
  });
  const matches = (existing.data || []).filter((asset) => asset.name === name);
  if (matches.length > 1) {
    throw new Error(
      `immutable GitHub Release asset collision: '${name}' exists more than once`,
    );
  }
  if (matches.length === 1) {
    const existingDigest = await existingReleaseAssetDigest({
      octokit,
      owner,
      repo,
      asset: matches[0],
    });
    if (existingDigest !== digest) {
      throw new Error(
        `immutable GitHub Release asset collision: '${name}' already exists with sha256:${existingDigest}, refusing sha256:${digest}`,
      );
    }
    return { action: "preserved", name, digest: `sha256:${digest}` };
  }
  await octokit.rest.repos.uploadReleaseAsset({
    owner,
    repo,
    release_id: releaseId,
    name,
    data,
  });
  return { action: "uploaded", name, digest: `sha256:${digest}` };
}

export function recoveryCompletedBeforeThisRun(receiptPath = "") {
  if (!receiptPath) return false;
  const receipt = JSON.parse(
    fs.readFileSync(path.resolve(receiptPath), "utf8"),
  );
  return (
    receipt.action === "reused" && receipt.transaction?.state === "complete"
  );
}

export async function publishGitHubReleaseEvidence({
  octokit,
  owner,
  repo,
  token,
  apiUrl,
  tag,
  target,
  channel = "",
  title = "",
  notes = "",
  publishEvidencePath = "",
  releasePassportPath = "",
  releasePassportOutputDir = "",
  additionalAssetPaths = [],
  reuseExistingCompleteEvidence = false,
  targetRef = "",
} = {}) {
  if (!tag) {
    throw new Error(
      "github-release=true requires promote-buildchain-ref to resolve a public release tag",
    );
  }
  const assets = collectGitHubReleaseEvidenceAssets({
    publishEvidencePath,
    releasePassportPath,
    releasePassportOutputDir,
    additionalAssetPaths,
  });
  const release = await ensureGitHubRelease({
    apiUrl,
    token,
    repository: `${owner}/${repo}`,
    tag,
    title: title || tag,
    notes: notes || `Buildchain release passport assets for ${tag}.`,
    target,
    channel,
  });
  if (reuseExistingCompleteEvidence) {
    const listed = await octokit.rest.repos.listReleaseAssets({
      owner,
      repo,
      release_id: release.release.id,
      per_page: 100,
    });
    if ((listed.data || []).some((asset) => asset?.name === "buildchain.release.json")) {
      return reuseCompleteGitHubReleaseEvidence({
        octokit,
        owner,
        repo,
        release: release.release,
        tag,
        target,
        channel,
        targetRef,
        additionalAssetPaths,
      });
    }
  }
  const assetResults = [];
  for (const assetPath of assets) {
    assetResults.push(
      await uploadReleaseAssetImmutable({
        octokit,
        owner,
        repo,
        releaseId: release.release.id,
        assetPath,
      }),
    );
  }
  return {
    action: release.action,
    url: release.release.html_url || "",
    tag,
    assetCount: assets.length,
    uploadedAssetCount: assetResults.filter(
      (asset) => asset.action === "uploaded",
    ).length,
    preservedAssetCount: assetResults.filter(
      (asset) => asset.action === "preserved",
    ).length,
  };
}

function writeJsonFile(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
  return resolved;
}

export async function publishDeclarativeGitHubReleaseEvidence({
  octokit,
  repository,
  sourceSha,
  version,
  tag,
  channel,
  publishEvidencePath,
  releasePassportPath,
  releasePassportOutputDir,
  additionalAssetPaths = [],
  statePath,
  declarationPath,
  targetRef = "",
  verifyPassport,
} = {}) {
  const evidenceAssetPaths = collectGitHubReleaseEvidenceAssets({
    publishEvidencePath,
    releasePassportPath,
    releasePassportOutputDir,
  });
  let assetPaths = collectGitHubReleaseEvidenceAssets({
    publishEvidencePath,
    releasePassportPath,
    releasePassportOutputDir,
    additionalAssetPaths,
  });
  const [owner, repo] = repository.split("/");
  let existingRelease = null;
  try {
    existingRelease = (await octokit.rest.repos.getReleaseByTag({ owner, repo, tag })).data;
  } catch (error) {
    if (Number(error?.status || error?.response?.status) !== 404) throw error;
  }
  if (existingRelease) {
    await reuseCompleteGitHubReleaseEvidence({
      octokit,
      owner,
      repo,
      release: existingRelease,
      tag,
      target: sourceSha,
      channel,
      targetRef,
      evidenceAssetPaths,
      additionalAssetPaths,
      verifyPassport,
    });
    const listed = await octokit.rest.repos.listReleaseAssets({
      owner,
      repo,
      release_id: existingRelease.id,
      per_page: 100,
    });
    const stagingDirectory = path.resolve(path.dirname(statePath), "observed-github-release-assets");
    fs.mkdirSync(stagingDirectory, { recursive: true });
    const names = new Set();
    assetPaths = [];
    for (const asset of listed.data || []) {
      const name = String(asset.name || "");
      if (!name || path.basename(name) !== name || names.has(name)) {
        throw new Error(`immutable GitHub Release asset collision: '${name}' is unsafe or duplicated`);
      }
      names.add(name);
      const response = await octokit.rest.repos.getReleaseAsset({
        owner,
        repo,
        asset_id: asset.id,
        headers: { accept: "application/octet-stream" },
      });
      const data = releaseAssetBytes(response.data);
      const declared = String(asset.digest || "").toLowerCase();
      const observed = `sha256:${sha256(data)}`;
      if (declared && declared !== observed) {
        throw new Error(`GitHub Release asset '${name}' digest does not match its public bytes`);
      }
      const stagedPath = path.join(stagingDirectory, name);
      fs.writeFileSync(stagedPath, data);
      assetPaths.push(stagedPath);
    }
  }
  const materialized = createDeclarativeGitHubReleasePlan({
    repository,
    sourceSha,
    version,
    tag,
    channel,
    assetPaths,
  });
  const resolvedStatePath = path.resolve(statePath);
  const resolvedDeclarationPath = writeJsonFile(
    declarationPath ||
      path.join(path.dirname(statePath), "github-release-declaration.json"),
    materialized.declaration,
  );
  let transaction = fs.existsSync(resolvedStatePath)
    ? readReleaseTailTransaction(resolvedStatePath)
    : createReleaseTailTransaction(materialized.plan);
  if (
    transaction.declarationRoot !== materialized.plan.declarationRoot ||
    transaction.planRoot !== materialized.plan.planRoot
  ) {
    throw new Error(
      "existing declarative release-tail state does not belong to the GitHub Release declaration",
    );
  }
  writeReleaseTailTransaction(resolvedStatePath, transaction);
  const artifactByRole = new Map(
    materialized.artifacts.map((entry) => [entry.role, entry]),
  );
  transaction = await executeReleaseTailTransaction(transaction, {
    adapters: createReleaseTailAdapterSet(materialized.declaration, {
      "github-release-assets": createGitHubReleaseAssetsAdapter({
        octokit,
        resolveArtifact(role) {
          return artifactByRole.get(role);
        },
      }),
    }),
    checkpoint: (checkpoint) =>
      writeReleaseTailTransaction(resolvedStatePath, checkpoint),
  });
  if (transaction.state !== "complete") {
    throw new Error(
      `declarative GitHub Release stopped in ${transaction.state}: ${transaction.failure?.code || "unknown"}`,
    );
  }
  const release = (
    await octokit.rest.repos.getReleaseByTag({ owner, repo, tag })
  ).data;
  return {
    action: transaction.receipts[0]?.action || "observed",
    url: release.html_url || "",
    tag,
    assetCount: materialized.artifacts.length,
    declarationPath: resolvedDeclarationPath,
    declarationRoot: transaction.declarationRoot,
    transaction,
    statePath: resolvedStatePath,
  };
}

export async function publishSelectedGitHubRelease({
  declarative,
  title,
  notes,
  legacyOptions,
  declarativeOptions,
} = {}) {
  if (declarative && (title || notes)) {
    throw new Error(
      "declarative-release-tail does not accept custom GitHub Release title or notes",
    );
  }
  return declarative
    ? publishDeclarativeGitHubReleaseEvidence(declarativeOptions)
    : publishGitHubReleaseEvidence(legacyOptions);
}
