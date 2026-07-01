const DEFAULT_REPOSITORY = "kungfu-systems/buildchain";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  detectPackageManager,
  getWorkspaceInfo,
} from "../../packages/core/package-manager.js";
import {
  discoverConfiguredVersionStateFiles,
  getVersionStrategy,
  getLifecycleStage,
  loadConfiguredAnchorManifest,
  loadBuildchainConfig,
  runLifecycleStage,
  updateConfiguredVersionStateContents,
} from "../../packages/core/buildchain-config.js";
import {
  assertTransactionIdentity,
  createReleaseTransaction,
  defaultPublishEvidencePath,
  defaultReleaseStatePath,
  releaseTransactionStateRef,
  parsePublishArtifactsJson,
  planTransactionRecovery,
  readPublishEvidence,
  readReleaseTransaction,
  transitionReleaseTransaction,
  validatePublishEvidence,
  writeReleaseTransaction,
} from "../../packages/core/publish-transaction.js";

const COMMIT_IDENTITY = {
  name: "Keren Dong",
  email: "keren.dong@kungfu.link",
};
const MAJOR_GATE_REF = "publish-gate/major";
const LEGACY_MAJOR_GATE_REF = "major-gate";

function parseTags(input) {
  const tags = String(input || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.length === 0) {
    throw new Error("At least one tag must be provided");
  }
  for (const tag of tags) {
    if (
      !/^v\d+$|^v\d+\.\d+$|^v\d+\.\d+-alpha$|^v\d+\.\d+\.\d+$|^v\d+\.\d+\.\d+-alpha\.\d+$/.test(
        tag,
      )
    ) {
      throw new Error(`Unsupported buildchain promotion tag: ${tag}`);
    }
  }
  return [...new Set(tags)];
}

function parseRepository(value) {
  const match = String(value || "").match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`Invalid repository: ${value}`);
  }
  return { owner: match[1], repo: match[2] };
}

function assertPromotableRepository(
  owner,
  repo,
  allowRepository = DEFAULT_REPOSITORY,
) {
  const allowed = parseRepository(allowRepository);
  if (owner !== allowed.owner || repo !== allowed.repo) {
    throw new Error(
      `Ref promotion is limited to ${allowRepository}; got ${owner}/${repo}`,
    );
  }
}

function getPromotionRule(targetRef) {
  if (targetRef === MAJOR_GATE_REF || targetRef === LEGACY_MAJOR_GATE_REF) {
    return {
      channel: "major",
      targetRef,
      legacyAlias: targetRef === LEGACY_MAJOR_GATE_REF,
      tags: [],
    };
  }
  const match = String(targetRef || "").match(
    /^(alpha|release)\/v(\d+)\/v(\d+)\.(\d+)$/,
  );
  if (!match) {
    throw new Error(
      `Ref promotion target must be alpha/vN/vN.M, release/vN/vN.M, publish-gate/major, or major-gate; got ${targetRef}`,
    );
  }
  const channel = match[1];
  const major = Number(match[2]);
  const minorMajor = Number(match[3]);
  const minor = Number(match[4]);
  if (major !== minorMajor) {
    throw new Error(`Ref promotion target major mismatch: ${targetRef}`);
  }
  const releasePrefix = `v${major}.${minor}`;
  const majorTag = `v${major}`;
  const minorTag = releasePrefix;
  const alphaTag = `${releasePrefix}-alpha`;
  if (channel === "alpha") {
    return {
      channel,
      major,
      minor,
      releasePrefix,
      majorTag,
      minorTag,
      alphaTag,
      tags: [alphaTag],
    };
  }
  return {
    channel,
    major,
    minor,
    releasePrefix,
    majorTag,
    minorTag,
    alphaTag,
    tags: [majorTag, minorTag],
  };
}

function assertPromotableTargetRef(targetRef) {
  getPromotionRule(targetRef);
}

function assertSha(sha) {
  if (!/^[0-9a-f]{40}$/i.test(String(sha || ""))) {
    throw new Error(`Invalid commit SHA: ${sha}`);
  }
}

function stripTagPrefix(tag) {
  return String(tag || "").replace(/^v/, "");
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonContent(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function detectVersionPackageManager(cwd) {
  try {
    const detected = detectPackageManager(cwd);
    return detected;
  } catch (error) {
    return {
      name: "unknown",
      reason: "not-detected",
      message: error.message,
    };
  }
}

function discoverVersionStateFiles(cwd = process.cwd()) {
  const loadedConfig = loadBuildchainConfig(cwd);
  if (loadedConfig?.config?.version) {
    const files = discoverConfiguredVersionStateFiles(cwd, loadedConfig);
    return {
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      packageManager: {
        name: "buildchain.toml",
        reason: "buildchain.toml",
        config: loadedConfig.path,
      },
      config: loadedConfig,
    };
  }

  const files = new Map();
  const addJsonVersionFile = (relativePath, kind) => {
    const filePath = path.join(cwd, relativePath);
    const content = readJsonIfExists(filePath);
    if (content && typeof content.version === "string") {
      files.set(relativePath.split(path.sep).join("/"), {
        kind,
        path: relativePath.split(path.sep).join("/"),
        content,
      });
    }
  };

  addJsonVersionFile("lerna.json", "lerna");
  addJsonVersionFile("package.json", "package");

  let workspaceInfo = {};
  try {
    workspaceInfo = getWorkspaceInfo(cwd);
  } catch {
    workspaceInfo = {};
  }
  for (const info of Object.values(workspaceInfo)) {
    if (info?.location) {
      addJsonVersionFile(path.join(info.location, "package.json"), "package");
    }
  }

  return {
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    packageManager: detectVersionPackageManager(cwd),
    config: loadedConfig,
  };
}

function updateVersionStateContents(files, version) {
  if (files.some((file) => file.type)) {
    return updateConfiguredVersionStateContents(files, version);
  }
  return files
    .map((file) => {
      const nextContent = { ...file.content, version };
      const before = writeJsonContent(file.content);
      const after = writeJsonContent(nextContent);
      return {
        path: file.path,
        kind: file.kind,
        changed: before !== after,
        content: after,
      };
    })
    .filter((file) => file.changed);
}

function expectedHeadRefForTarget(targetRef) {
  const rule = getPromotionRule(targetRef);
  if (rule.channel === "major") {
    return "release/vN/vN.M";
  }
  return rule.channel === "alpha"
    ? `dev/v${rule.major}/v${rule.major}.${rule.minor}`
    : `alpha/v${rule.major}/v${rule.major}.${rule.minor}`;
}

function parseReleaseLineRef(ref) {
  const match = String(ref || "").match(/^release\/v(\d+)\/v(\d+)\.(\d+)$/);
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  const minorMajor = Number(match[2]);
  const minor = Number(match[3]);
  if (major !== minorMajor) {
    throw new Error(`Release ref major mismatch: ${ref}`);
  }
  return { ref, major, minor };
}

function assertAllowedLocalChanges(cwd, allowedPaths) {
  const allowed = new Set(allowedPaths);
  const output = execSync("git status --porcelain --untracked-files=all", {
    cwd,
    encoding: "utf8",
  }).trimEnd();
  const unexpected = output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const status = line.slice(0, 2);
      const filePath = line.slice(3).trim();
      return !(
        allowed.has(filePath) &&
        status !== "??" &&
        !status.includes("D")
      );
    });
  if (unexpected.length > 0) {
    throw new Error(
      `Version verification changed files outside version state: ${unexpected.join(", ")}`,
    );
  }
}

function applyLocalVersionState(cwd, changedFiles) {
  for (const file of changedFiles) {
    fs.writeFileSync(path.join(cwd, file.path), file.content);
  }
}

function runVersionVerification({ cwd, command, loadedConfig, version, changedFiles, allowedPaths, env: extraEnv }) {
  const lifecycleVerify = getLifecycleStage(loadedConfig, "verify");
  if (!command && !lifecycleVerify) {
    return;
  }
  applyLocalVersionState(cwd, changedFiles);
  const env = {
    ...process.env,
    BUILDCHAIN_VERSION: version,
    ...(extraEnv || {}),
  };
  if (command) {
    execSync(command, { cwd, env, stdio: "inherit", shell: true });
  } else {
    runLifecycleStage({
      cwd,
      loadedConfig,
      name: "verify",
      stage: lifecycleVerify,
      env: { BUILDCHAIN_VERSION: version, ...(extraEnv || {}) },
    });
  }
  assertAllowedLocalChanges(cwd, allowedPaths);
}

function versionVerificationEnv(versionStrategy, anchorManifest) {
  return {
    BUILDCHAIN_VERSION_STRATEGY: versionStrategy.strategy,
    BUILDCHAIN_VERSION_NEXT: versionStrategy.next,
    ...(anchorManifest
      ? {
          BUILDCHAIN_ANCHOR_MANIFEST: anchorManifest.path,
          BUILDCHAIN_ANCHOR_MANIFEST_JSON: JSON.stringify(anchorManifest.fields),
        }
      : {}),
  };
}

function runPublishCommand({ cwd, command, loadedConfig, env }) {
  const lifecyclePublish = getLifecycleStage(loadedConfig, "publish");
  if (command) {
    execSync(command, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: true,
    });
    return "workflow-input";
  }
  if (lifecyclePublish) {
    runLifecycleStage({
      cwd,
      loadedConfig,
      name: "publish",
      stage: lifecyclePublish,
      env,
    });
    return "buildchain.toml";
  }
  return "none";
}

function materialErrorRequiresRepair(error) {
  return /release_material_sha mismatch|source_sha mismatch|release_sha mismatch|version mismatch|target_ref mismatch|artifact digest mismatch|required artifact missing/.test(
    error.message || "",
  );
}

function ensureTransactionCanResume({ existing, expected, explicitOverride }) {
  if (!existing) {
    return;
  }
  assertTransactionIdentity(existing, expected, { allowToolingDrift: true });
  const recovery = planTransactionRecovery({
    transaction: existing,
    explicitOverride,
  });
  if (recovery.blocked) {
    throw new Error(`release transaction cannot resume: ${recovery.reason}`);
  }
}

function validateTransactionEvidence({
  evidencePath,
  version,
  channel,
  sourceSha,
  releaseSha,
  targetRef,
  releaseMaterialSha,
  publishToolingSha,
  requiredArtifacts,
}) {
  const evidence = readPublishEvidence(evidencePath);
  if (!evidence) {
    throw new Error(`publish evidence missing: ${evidencePath}`);
  }
  const validation = validatePublishEvidence({
    evidence,
    version,
    channel,
    sourceSha,
    releaseSha,
    targetRef,
    releaseMaterialSha,
    publishToolingSha,
    requiredArtifacts,
  });
  if (!validation.valid) {
    throw new Error(`publish evidence invalid: ${validation.errors.join("; ")}`);
  }
  return validation;
}

function durableTransactionHeadRef(transaction) {
  if (!transaction?.state_ref) {
    throw new Error("release transaction durable state_ref is required");
  }
  return `heads/${transaction.state_ref}`;
}

function decodeGitBlob(blob) {
  const content = blob?.content || "";
  return Buffer.from(
    content.replace(/\n/g, ""),
    blob?.encoding === "base64" ? "base64" : "utf8",
  ).toString("utf8");
}

async function getGitRefOrUndefined({ octokit, owner, repo, ref }) {
  try {
    const { data } = await octokit.rest.git.getRef({ owner, repo, ref });
    return data;
  } catch (error) {
    if (notFound(error)) {
      return undefined;
    }
    throw error;
  }
}

async function restoreDurableReleaseTransaction({
  octokit,
  owner,
  repo,
  stateRef,
  statePath,
  evidencePath,
}) {
  if (!octokit || !stateRef) {
    return undefined;
  }
  const ref = await getGitRefOrUndefined({
    octokit,
    owner,
    repo,
    ref: `heads/${stateRef}`,
  });
  if (!ref) {
    return undefined;
  }
  const commitSha = ref.object?.sha;
  const { data: commit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: commitSha,
  });
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: commit.tree.sha,
    recursive: "1",
  });
  const entryByPath = new Map((tree.tree || []).map((entry) => [entry.path, entry]));
  const stateEntry = entryByPath.get("state.json");
  if (!stateEntry) {
    throw new Error(`durable release transaction ${stateRef} is missing state.json`);
  }
  const { data: stateBlob } = await octokit.rest.git.getBlob({
    owner,
    repo,
    file_sha: stateEntry.sha,
  });
  const record = JSON.parse(decodeGitBlob(stateBlob));
  writeReleaseTransaction(statePath, record);

  const evidenceEntry = entryByPath.get("evidence.json");
  if (evidenceEntry) {
    const { data: evidenceBlob } = await octokit.rest.git.getBlob({
      owner,
      repo,
      file_sha: evidenceEntry.sha,
    });
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, decodeGitBlob(evidenceBlob));
  }

  return record;
}

async function persistDurableReleaseTransaction({
  octokit,
  owner,
  repo,
  cwd,
  transaction,
  evidencePath,
}) {
  if (!octokit || !transaction) {
    return undefined;
  }
  const refName = durableTransactionHeadRef(transaction);
  const currentRef = await getGitRefOrUndefined({ octokit, owner, repo, ref: refName });

  const stateBlob = await octokit.rest.git.createBlob({
    owner,
    repo,
    content: JSON.stringify(transaction, null, 2) + "\n",
    encoding: "utf-8",
  });
  const treeEntries = [
    {
      path: "state.json",
      mode: "100644",
      type: "blob",
      sha: stateBlob.data.sha,
    },
  ];
  if (evidencePath && fs.existsSync(evidencePath)) {
    const evidenceBlob = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: fs.readFileSync(evidencePath, "utf8"),
      encoding: "utf-8",
    });
    treeEntries.push({
      path: "evidence.json",
      mode: "100644",
      type: "blob",
      sha: evidenceBlob.data.sha,
    });
  }

  const createStateCommit = async (parentSha) => {
    let baseTree;
    const parents = [];
    if (parentSha) {
      const { data: currentCommit } = await octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: parentSha,
      });
      baseTree = currentCommit.tree?.sha;
      parents.push(parentSha);
    }
    const tree = await octokit.rest.git.createTree({
      owner,
      repo,
      tree: treeEntries,
      ...(baseTree ? { base_tree: baseTree } : {}),
    });
    return octokit.rest.git.createCommit({
      owner,
      repo,
      message: `chore(buildchain): persist release transaction ${transaction.exact_tag}`,
      tree: tree.data.sha,
      parents,
    });
  };
  let commit = await createStateCommit(currentRef?.object?.sha);
  if (currentRef) {
    try {
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: refName,
        sha: commit.data.sha,
        force: false,
      });
    } catch (error) {
      if (!nonFastForwardUpdateRejected(error)) {
        throw error;
      }
      const latestRef = await getGitRefOrUndefined({ octokit, owner, repo, ref: refName });
      commit = await createStateCommit(latestRef?.object?.sha);
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: refName,
        sha: commit.data.sha,
        force: false,
      });
    }
  } else {
    try {
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/${refName}`,
        sha: commit.data.sha,
      });
    } catch (error) {
      if (!referenceAlreadyExists(error)) {
        throw error;
      }
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: refName,
        sha: commit.data.sha,
        force: true,
      });
    }
  }
  return {
    ref: transaction.state_ref,
    sha: commit.data.sha,
    statePath: path.relative(cwd, transaction.state_path || "").split(path.sep).join("/"),
  };
}

async function releaseCommitIncludesTransactionHead({
  octokit,
  owner,
  repo,
  releaseSha,
  transactionReleaseSha,
}) {
  if (!octokit || !releaseSha || !transactionReleaseSha) {
    return false;
  }
  if (releaseSha === transactionReleaseSha) {
    return true;
  }
  const { data: commit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: releaseSha,
  });
  return (commit.parents || []).some((parent) => parent.sha === transactionReleaseSha);
}

async function runPublishTransaction({
  octokit,
  owner,
  repo,
  cwd,
  loadedConfig,
  targetRef,
  sourceSha,
  releaseSha,
  version,
  exactTag,
  channel,
  line,
  publishTransaction,
  publishCommand = "",
  publishEvidencePath = "",
  transactionStatePath = "",
  publishRequiredArtifactsJson = "",
  releaseMaterialSha = "",
  publishToolingSha = "",
  actor = "",
  runId = "",
  explicitOverride = false,
  allowVersionStateFinalization = false,
}) {
  const lifecyclePublish = getLifecycleStage(loadedConfig, "publish");
  const enabled = Boolean(publishTransaction || publishCommand || lifecyclePublish);
  if (!enabled) {
    return undefined;
  }

  const repository = `${owner}/${repo}`;
  const resolvedStatePath = path.resolve(
    cwd,
    transactionStatePath || defaultReleaseStatePath(exactTag, cwd),
  );
  const resolvedEvidencePath = path.resolve(
    cwd,
    publishEvidencePath || defaultPublishEvidencePath(exactTag, cwd),
  );
  const requiredArtifacts = parsePublishArtifactsJson(
    publishRequiredArtifactsJson,
    "publish-required-artifacts-json",
  );
  const expected = {
    repository,
    version,
    sourceSha,
    targetRef,
    releaseMaterialSha: releaseMaterialSha || releaseSha,
    publishToolingSha: publishToolingSha || releaseSha,
  };

  const durableStateRef = releaseTransactionStateRef(version);
  const durableExisting = await restoreDurableReleaseTransaction({
    octokit,
    owner,
    repo,
    stateRef: durableStateRef,
    statePath: resolvedStatePath,
    evidencePath: resolvedEvidencePath,
  });
  const localExisting = readReleaseTransaction(resolvedStatePath);
  if (durableExisting && localExisting && durableExisting.id !== localExisting.id) {
    throw new Error(
      `release transaction local state ${localExisting.id} conflicts with durable state ${durableExisting.id}`,
    );
  }
  const existing = durableExisting || localExisting;
  let versionStateFinalization = false;
  try {
    ensureTransactionCanResume({ existing, expected, explicitOverride });
  } catch (error) {
    const canFinalizeVersionState =
      allowVersionStateFinalization &&
      materialErrorRequiresRepair(error) &&
      existing?.version === version &&
      existing?.exact_tag === exactTag &&
      existing?.target_ref === targetRef &&
      ["published", "finalizing", "complete"].includes(existing.state || "") &&
      (await releaseCommitIncludesTransactionHead({
        octokit,
        owner,
        repo,
        releaseSha,
        transactionReleaseSha: existing.release_sha,
      }));
    if (!canFinalizeVersionState) {
      throw error;
    }
    versionStateFinalization = true;
  }
  let transaction =
    existing ||
    createReleaseTransaction({
      repository,
      version,
      exactTag,
      channel,
      line,
      sourceSha,
      targetRef,
      releaseSha,
      releaseMaterialSha: expected.releaseMaterialSha,
      publishToolingSha: expected.publishToolingSha,
      statePath: resolvedStatePath,
      evidencePath: resolvedEvidencePath,
      actor,
      runId,
    });
  const persistTransaction = async (record) => {
    const persisted = writeReleaseTransaction(resolvedStatePath, record);
    const durable = await persistDurableReleaseTransaction({
      octokit,
      owner,
      repo,
      cwd,
      transaction: persisted,
      evidencePath: resolvedEvidencePath,
    });
    return { transaction: persisted, durable };
  };
  let durable;
  ({ transaction, durable } = await persistTransaction(transaction));
  if (versionStateFinalization) {
    return {
      transaction,
      validation: undefined,
      statePath: resolvedStatePath,
      evidencePath: resolvedEvidencePath,
      durable,
      octokit,
      owner,
      repo,
      cwd,
    };
  }

  let validation;
  try {
    const evidence = readPublishEvidence(resolvedEvidencePath);
    if (evidence) {
      validation = validatePublishEvidence({
        evidence,
        version,
        channel,
        sourceSha,
        releaseSha,
        targetRef,
        releaseMaterialSha: expected.releaseMaterialSha,
        publishToolingSha: expected.publishToolingSha,
        requiredArtifacts,
      });
    }
    const recovery = planTransactionRecovery({
      transaction,
      evidence,
      validation,
      explicitOverride,
    });
    if (recovery.blocked) {
      throw new Error(`release transaction cannot recover: ${recovery.reason}`);
    }
    if (!validation?.valid) {
      if (transaction.state === "repair_required" && explicitOverride) {
        transaction = transitionReleaseTransaction(transaction, "publishing", {
          actor,
          runId,
          failure: "",
        });
      } else if (transaction.state !== "publishing") {
        transaction = transitionReleaseTransaction(transaction, "publishing", {
          actor,
          runId,
        });
      }
      ({ transaction, durable } = await persistTransaction(transaction));
      const source = runPublishCommand({
        cwd,
        command: publishCommand,
        loadedConfig,
        env: {
          BUILDCHAIN_VERSION: version,
          BUILDCHAIN_CHANNEL: channel,
          BUILDCHAIN_SOURCE_SHA: sourceSha,
          BUILDCHAIN_TARGET_REF: targetRef,
          BUILDCHAIN_RELEASE_STATE: resolvedStatePath,
          BUILDCHAIN_EVIDENCE_DIR: path.dirname(resolvedEvidencePath),
          BUILDCHAIN_RELEASE_SHA: releaseSha,
          BUILDCHAIN_RELEASE_MATERIAL_SHA: expected.releaseMaterialSha,
          BUILDCHAIN_PUBLISH_TOOLING_SHA: expected.publishToolingSha,
          BUILDCHAIN_PUBLISH_EVIDENCE: resolvedEvidencePath,
        },
      });
      if (source === "none") {
        throw new Error("publish transaction requires lifecycle.publish, publish-command, or existing evidence");
      }
    }
    validation = validateTransactionEvidence({
      evidencePath: resolvedEvidencePath,
      version,
      channel,
      sourceSha,
      releaseSha,
      targetRef,
      releaseMaterialSha: expected.releaseMaterialSha,
      publishToolingSha: expected.publishToolingSha,
      requiredArtifacts,
    });
    if (transaction.state === "publishing" || transaction.state === "publish_failed") {
      transaction = transitionReleaseTransaction(transaction, "published", {
        actor,
        runId,
        failure: "",
      });
    }
    transaction = {
      ...transaction,
      artifacts: validation.evidence.artifacts,
      evidence: [path.relative(cwd, resolvedEvidencePath).split(path.sep).join("/")],
    };
    ({ transaction, durable } = await persistTransaction(transaction));
    return {
      transaction,
      validation,
      statePath: resolvedStatePath,
      evidencePath: resolvedEvidencePath,
      durable,
      octokit,
      owner,
      repo,
      cwd,
    };
  } catch (error) {
    const nextState = materialErrorRequiresRepair(error)
      ? "repair_required"
      : "publish_failed";
    if (transaction.state !== "repair_required") {
      transaction = transitionReleaseTransaction(transaction, nextState, {
        actor,
        runId,
        failure: error.message,
      });
      await persistTransaction(transaction);
    }
    throw error;
  }
}

async function persistTransactionResult(result, transaction) {
  const persisted = writeReleaseTransaction(result.statePath, transaction);
  const durable = await persistDurableReleaseTransaction({
    octokit: result.octokit,
    owner: result.owner,
    repo: result.repo,
    cwd: result.cwd,
    transaction: persisted,
    evidencePath: result.evidencePath,
  });
  return { ...result, transaction: persisted, durable };
}

async function beginTransactionFinalization(result, actor, runId) {
  if (!result?.transaction || result.transaction.state === "finalizing" || result.transaction.state === "complete") {
    return result;
  }
  const transaction = transitionReleaseTransaction(result.transaction, "finalizing", {
    actor,
    runId,
  });
  return persistTransactionResult(result, transaction);
}

async function completeTransactionFinalization(result, actor, runId) {
  if (!result?.transaction || result.transaction.state === "complete") {
    return result;
  }
  const current = result.transaction.state === "published"
    ? transitionReleaseTransaction(result.transaction, "finalizing", { actor, runId })
    : result.transaction;
  const transaction = transitionReleaseTransaction(current, "complete", {
    actor,
    runId,
  });
  return persistTransactionResult(result, transaction);
}

async function getCommitInfo(octokit, owner, repo, sha) {
  const { data } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: sha,
  });
  return {
    treeSha: data.tree?.sha,
    parents: (data.parents || []).map((parent) => parent.sha),
  };
}

async function assertChannelPromotionPr({
  octokit,
  owner,
  repo,
  sha,
  targetRef,
}) {
  const expectedHeadRef = expectedHeadRefForTarget(targetRef);
  const { data: pullRequests } =
    await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: sha,
    });
  const matchingPullRequest = pullRequests.find((pullRequest) => {
    const baseRef = pullRequest.base?.ref;
    const headRef = pullRequest.head?.ref;
    const headRepo = pullRequest.head?.repo?.full_name;
    if (getPromotionRule(targetRef).channel === "major") {
      return (
        pullRequest.merged_at &&
        baseRef === targetRef &&
        parseReleaseLineRef(headRef) &&
        headRepo === `${owner}/${repo}`
      );
    }
    return (
      pullRequest.merged_at &&
      baseRef === targetRef &&
      headRef === expectedHeadRef &&
      headRepo === `${owner}/${repo}`
    );
  });
  if (!matchingPullRequest) {
    throw new Error(
      `Promotion source ${sha} must come from a merged same-repository PR ${expectedHeadRef} -> ${targetRef}`,
    );
  }
  return matchingPullRequest;
}

async function getMajorGateSource({
  octokit,
  owner,
  repo,
  sha,
  targetRef = MAJOR_GATE_REF,
}) {
  const pullRequest = await assertChannelPromotionPr({
    octokit,
    owner,
    repo,
    sha,
    targetRef,
  });
  const source = parseReleaseLineRef(pullRequest.head?.ref);
  if (!source) {
    throw new Error(
      `Promotion source ${sha} must come from a merged same-repository PR release/vN/vN.M -> ${targetRef}`,
    );
  }
  return {
    source,
    pullRequest,
    major: source.major + 1,
    minor: 0,
    releasePrefix: `v${source.major + 1}.0`,
    majorTag: `v${source.major + 1}`,
    minorTag: `v${source.major + 1}.0`,
    alphaTag: `v${source.major + 1}.0-alpha`,
  };
}

async function assertProtectedChannel({
  octokit,
  owner,
  repo,
  targetRef,
  requiredStatusCheck = "check",
}) {
  let protection;
  try {
    ({ data: protection } = await octokit.rest.repos.getBranchProtection({
      owner,
      repo,
      branch: targetRef,
    }));
  } catch (error) {
    if (error.status === 403) {
      throw new Error(
        `Protected channel ${targetRef} protection details must be readable to verify admin enforcement`,
      );
    }
    throw error;
  }
  if (protection.enforce_admins?.enabled !== true) {
    throw new Error(
      `Protected channel ${targetRef} must enforce branch protection for administrators`,
    );
  }
  if (protection.allow_force_pushes?.enabled !== false) {
    throw new Error(`Protected channel ${targetRef} must disallow force pushes`);
  }
  if (protection.allow_deletions?.enabled !== false) {
    throw new Error(`Protected channel ${targetRef} must disallow branch deletion`);
  }
  if (protection.required_conversation_resolution?.enabled !== true) {
    throw new Error(
      `Protected channel ${targetRef} must require conversation resolution`,
    );
  }
  const reviews = protection.required_pull_request_reviews;
  if (!reviews || Number(reviews.required_approving_review_count || 0) < 1) {
    throw new Error(
      `Protected channel ${targetRef} must require at least one approving review`,
    );
  }
  const checks = protection.required_status_checks;
  if (!checks?.strict) {
    throw new Error(`Protected channel ${targetRef} must require strict status checks`);
  }
  const checkNames = [
    ...(checks.contexts || []),
    ...((checks.checks || []).map((check) => check.context || check.app_id) || []),
  ].map(String);
  if (!checkNames.some((name) => name.includes(requiredStatusCheck))) {
    throw new Error(
      `Protected channel ${targetRef} must require a ${requiredStatusCheck} status check`,
    );
  }
}

function latestAlphaForPatch(refs, releasePrefix, patch) {
  return refs
    .map((ref) => {
      const parsed = parseAlphaPrereleaseTag(ref.ref, releasePrefix);
      if (!parsed || parsed.patch !== patch) {
        return undefined;
      }
      return { ...parsed, sha: ref.object?.sha };
    })
    .filter(Boolean)
    .sort((a, b) => b.prerelease - a.prerelease)[0];
}

function resolveTagsForTarget(targetRef, inputTags) {
  const rule = getPromotionRule(targetRef);
  if (rule.channel === "major" && (!inputTags || inputTags.length === 0)) {
    return [];
  }
  if (rule.channel === "major") {
    for (const tag of inputTags) {
      if (!/^v\d+$|^v\d+\.0$|^v\d+\.0-alpha$|^v\d+\.0\.\d+$|^v\d+\.0\.\d+-alpha\.\d+$/.test(tag)) {
        throw new Error(`Tag ${tag} is not allowed for publish-gate/major promotion`);
      }
    }
    return inputTags;
  }
  const tags = inputTags && inputTags.length > 0 ? inputTags : rule.tags;
  for (const tag of tags) {
    const isLineReleaseTag =
      tag.startsWith(`${rule.releasePrefix}.`) && !tag.includes("-alpha.");
    const isLineAlphaTag =
      tag === rule.alphaTag ||
      (tag.startsWith(`${rule.releasePrefix}.`) && tag.includes("-alpha."));
    const allowed =
      rule.channel === "release"
        ? tag === rule.majorTag ||
          tag === rule.minorTag ||
          tag === rule.alphaTag ||
          isLineReleaseTag ||
          isLineAlphaTag
        : tag === rule.alphaTag || isLineAlphaTag;
    if (!allowed) {
      throw new Error(
        `Tag ${tag} is not allowed for ${rule.channel} promotion`,
      );
    }
  }
  return tags;
}

function parseReleasePatchTag(refName, releasePrefix) {
  const match = String(refName || "").match(
    new RegExp(`^refs/tags/${releasePrefix.replace(".", "\\.")}\\.(\\d+)$`),
  );
  if (!match) {
    return undefined;
  }
  return {
    tag: refName.replace(/^refs\/tags\//, ""),
    patch: Number(match[1]),
  };
}

function parseAlphaPrereleaseTag(refName, releasePrefix) {
  const match = String(refName || "").match(
    new RegExp(
      `^refs/tags/${releasePrefix.replace(".", "\\.")}\\.(\\d+)-alpha\\.(\\d+)$`,
    ),
  );
  if (!match) {
    return undefined;
  }
  return {
    tag: refName.replace(/^refs\/tags\//, ""),
    patch: Number(match[1]),
    prerelease: Number(match[2]),
  };
}

function parseAlphaPrereleaseVersion(version, releasePrefix) {
  return parseAlphaPrereleaseTag(`refs/tags/v${version}`, releasePrefix);
}

function parseAlphaTransactionStateRef(refName, releasePrefix) {
  const statePrefix = releasePrefix.replace(/^v/, "").replaceAll(".", "-");
  const match = String(refName || "").match(
    new RegExp(
      `^refs/heads/buildchain/release-state/${statePrefix}-(\\d+)-alpha-(\\d+)$`,
    ),
  );
  if (!match) {
    return undefined;
  }
  return {
    tag: `${releasePrefix}.${Number(match[1])}-alpha.${Number(match[2])}`,
    patch: Number(match[1]),
    prerelease: Number(match[2]),
    occupied: true,
  };
}

function getVersionFileValue(file) {
  if (file.type === "json" || file.type === "toml") {
    return String(file.key || "")
      .split(".")
      .reduce((current, segment) => current?.[segment], file.content);
  }
  if (file.type === "regex") {
    const match = file.source.match(file.pattern);
    return match?.groups?.version;
  }
  return file.content?.version;
}

function currentAlphaVersionState({ cwd, refs, releasePrefix }) {
  const discovered = discoverVersionStateFiles(cwd);
  if (discovered.files.length === 0) {
    return undefined;
  }
  const versions = [
    ...new Set(
      discovered.files
        .map((file) => getVersionFileValue(file))
        .filter((version) => typeof version === "string" && version.trim()),
    ),
  ];
  if (versions.length !== 1) {
    return undefined;
  }
  const parsed = parseAlphaPrereleaseVersion(versions[0], releasePrefix);
  if (!parsed) {
    return undefined;
  }
  const hasDurableState = refs.some((ref) => {
    const candidate = parseAlphaPrereleaseRef(ref.ref, releasePrefix);
    return candidate?.source === "release-state" && candidate.tag === `v${versions[0]}`;
  });
  if (!hasDurableState) {
    return undefined;
  }
  return {
    ...parsed,
    tag: `v${versions[0]}`,
    version: versions[0],
  };
}

function parseAlphaPrereleaseRef(refName, releasePrefix) {
  const tag = parseAlphaPrereleaseTag(refName, releasePrefix);
  if (tag) {
    return { ...tag, source: "tag" };
  }
  const stateRef = parseAlphaTransactionStateRef(refName, releasePrefix);
  if (stateRef) {
    return { ...stateRef, source: "release-state" };
  }
  return undefined;
}

function selectReleaseTag({ refs, releasePrefix, sha }) {
  const releaseTags = refs
    .map((ref) => {
      const parsed = parseReleasePatchTag(ref.ref, releasePrefix);
      if (!parsed) {
        return undefined;
      }
      return { ...parsed, sha: ref.object?.sha };
    })
    .filter(Boolean)
    .sort((a, b) => a.patch - b.patch);

  const existingForSha = releaseTags.find((tag) => tag.sha === sha);
  if (existingForSha) {
    return {
      tag: existingForSha.tag,
      patch: existingForSha.patch,
      exists: true,
    };
  }
  const latestPatch =
    releaseTags.length > 0 ? releaseTags[releaseTags.length - 1].patch : -1;
  return {
    tag: `${releasePrefix}.${latestPatch + 1}`,
    patch: latestPatch + 1,
    exists: false,
  };
}

function selectAlphaTag({ refs, releasePrefix, sha, patchAfterRelease }) {
  const alphaTags = refs
    .map((ref) => {
      const parsed = parseAlphaPrereleaseRef(ref.ref, releasePrefix);
      if (!parsed) {
        return undefined;
      }
      return {
        ...parsed,
        sha: parsed.source === "tag" ? ref.object?.sha : undefined,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.patch - b.patch || a.prerelease - b.prerelease);

  if (patchAfterRelease !== undefined) {
    const samePatchTags = alphaTags.filter(
      (tag) => tag.patch === patchAfterRelease,
    );
    const existingForSha = samePatchTags.find(
      (tag) => tag.source === "tag" && tag.sha === sha,
    );
    if (existingForSha) {
      return {
        tag: existingForSha.tag,
        patch: existingForSha.patch,
        prerelease: existingForSha.prerelease,
        sha: existingForSha.sha,
        exists: true,
      };
    }
    const prepared = samePatchTags.find((tag) => tag.source === "tag");
    if (prepared) {
      return {
        tag: prepared.tag,
        patch: prepared.patch,
        prerelease: prepared.prerelease,
        sha: prepared.sha,
        exists: true,
      };
    }
    const latestPrerelease =
      samePatchTags.length > 0
        ? samePatchTags[samePatchTags.length - 1].prerelease
        : -1;
    const prerelease = latestPrerelease + 1;
    return {
      tag: `${releasePrefix}.${patchAfterRelease}-alpha.${prerelease}`,
      patch: patchAfterRelease,
      prerelease,
      exists: false,
    };
  }

  const existingForSha = alphaTags.find(
    (tag) => tag.source === "tag" && tag.sha === sha,
  );
  if (existingForSha) {
    return {
      tag: existingForSha.tag,
      patch: existingForSha.patch,
      prerelease: existingForSha.prerelease,
      sha: existingForSha.sha,
      exists: true,
    };
  }

  const releaseTags = refs
    .map((ref) => parseReleasePatchTag(ref.ref, releasePrefix))
    .filter(Boolean)
    .sort((a, b) => a.patch - b.patch);
  const latestReleasePatch =
    releaseTags.length > 0 ? releaseTags[releaseTags.length - 1].patch : -1;
  const latestAlpha =
    alphaTags.length > 0 ? alphaTags[alphaTags.length - 1] : undefined;
  if (latestAlpha && latestAlpha.patch >= latestReleasePatch + 1) {
    const prerelease = latestAlpha.prerelease + 1;
    return {
      tag: `${releasePrefix}.${latestAlpha.patch}-alpha.${prerelease}`,
      patch: latestAlpha.patch,
      prerelease,
      exists: false,
    };
  }

  const patch = latestReleasePatch + 1;
  return {
    tag: `${releasePrefix}.${patch}-alpha.0`,
    patch,
    prerelease: 0,
    exists: false,
  };
}

function notFound(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return (
    status === 404 ||
    (status === 422 && /Reference does not exist/i.test(message))
  );
}

function referenceAlreadyExists(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return status === 422 && /Reference already exists/i.test(message);
}

function protectedBranchUpdateRejected(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return (
    status === 422 &&
    /Changes must be made through a pull request|Required status check/i.test(message)
  );
}

function nonFastForwardUpdateRejected(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return status === 422 && /Update is not a fast forward/i.test(message);
}

function versionStateBranchName(branch, sha) {
  return `buildchain/version-state/${branch.replaceAll("/", "-")}/${sha.slice(0, 12)}`;
}

function parseVersionStateBranchName(branch) {
  const publishGateMajorMatch = String(branch || "").match(
    /^buildchain\/version-state\/publish-gate-major\/[0-9a-f]{12,40}$/,
  );
  if (publishGateMajorMatch) {
    return MAJOR_GATE_REF;
  }
  const majorGateMatch = String(branch || "").match(
    /^buildchain\/version-state\/major-gate\/[0-9a-f]{12,40}$/,
  );
  if (majorGateMatch) {
    return LEGACY_MAJOR_GATE_REF;
  }
  const match = String(branch || "").match(
    /^buildchain\/version-state\/(alpha|release)-v(\d+)-v(\d+\.\d+)\/[0-9a-f]{12,40}$/,
  );
  if (!match) {
    return undefined;
  }
  return `${match[1]}/v${match[2]}/v${match[3]}`;
}

async function promoteBuildchainRefs({
  octokit,
  owner,
  repo,
  sha,
  targetRef,
  tags,
  dryRun = false,
  allowRepository = DEFAULT_REPOSITORY,
  cwd = process.cwd(),
  versionState = true,
  requireVersionState = false,
  requireGovernance = false,
  verificationCommand = "",
  requiredStatusCheck = "check",
  publishTransaction = false,
  publishCommand = "",
  publishEvidencePath = "",
  transactionStatePath = "",
  publishRequiredArtifactsJson = "",
  releaseMaterialSha = "",
  publishToolingSha = "",
  actor = process.env.GITHUB_ACTOR || process.env.USER || "",
  runId = process.env.GITHUB_RUN_ID || "",
  publishTransactionOverride = false,
}) {
  assertPromotableRepository(owner, repo, allowRepository);
  assertPromotableTargetRef(targetRef);
  assertSha(sha);
  const rule = getPromotionRule(targetRef);
  const requestedTags = tags
    ? resolveTagsForTarget(targetRef, tags)
    : undefined;

  const { data: branchRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${targetRef}`,
  });
  const branchSha = branchRef.object.sha;
  if (branchSha !== sha) {
    throw new Error(
      `Ref ${targetRef} points at ${branchSha}, not requested SHA ${sha}`,
    );
  }

  const updates = [];

  const listLineRefs = async (releasePrefix = rule.releasePrefix) => {
    const { data: tagRefs } = await octokit.rest.git.listMatchingRefs({
      owner,
      repo,
      ref: `tags/${releasePrefix}.`,
    });
    const statePrefix = releasePrefix.replace(/^v/, "").replaceAll(".", "-");
    const { data: stateRefs } = await octokit.rest.git.listMatchingRefs({
      owner,
      repo,
      ref: `heads/buildchain/release-state/${statePrefix}-`,
    });
    return [...tagRefs, ...stateRefs];
  };

  const ensureTag = async (tag, tagSha = sha) => {
    if (dryRun) {
      updates.push({ tag, action: "dry-run", sha: tagSha });
      return;
    }
    try {
      const { data: tagRef } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `tags/${tag}`,
      });
      if (tagRef.object.sha !== tagSha) {
        throw new Error(
          `Tag ${tag} points at ${tagRef.object.sha}, not requested SHA ${tagSha}`,
        );
      }
      updates.push({ tag, action: "existing", sha: tagSha });
    } catch (error) {
      if (!notFound(error)) {
        throw error;
      }
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${tag}`,
        sha: tagSha,
      });
      updates.push({ tag, action: "created", sha: tagSha });
    }
  };

  const updateTag = async (tag, tagSha = sha) => {
    if (dryRun) {
      updates.push({ tag, action: "dry-run", sha: tagSha });
      return;
    }
    try {
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `tags/${tag}`,
        sha: tagSha,
        force: true,
      });
      updates.push({ tag, action: "updated", sha: tagSha });
    } catch (error) {
      if (!notFound(error)) {
        throw error;
      }
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${tag}`,
        sha: tagSha,
      });
      updates.push({ tag, action: "created", sha: tagSha });
    }
  };

  const readRefSha = async (ref) => {
    try {
      const { data: refData } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref,
      });
      return refData.object.sha;
    } catch (error) {
      if (notFound(error)) {
        return undefined;
      }
      throw error;
    }
  };

  const openVersionStatePullRequest = async ({ branch, branchSha, title, body }) => {
    const headBranch = versionStateBranchName(branch, branchSha);
    const headRef = `heads/${headBranch}`;
    const existingHeadSha = await readRefSha(headRef);
    if (!existingHeadSha) {
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/${headRef}`,
        sha: branchSha,
      });
    } else if (existingHeadSha !== branchSha) {
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: headRef,
        sha: branchSha,
        force: true,
      });
    }

    const { data: openPulls } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      head: `${owner}:${headBranch}`,
      base: branch,
    });
    const pullRequest =
      openPulls[0] ||
      (
        await octokit.rest.pulls.create({
          owner,
          repo,
          title,
          head: headBranch,
          base: branch,
          body,
          maintainer_can_modify: true,
        })
      ).data;
    updates.push({
      ref: branch,
      action: "pending-version-state-pr",
      sha: branchSha,
      pullRequest: pullRequest.html_url || pullRequest.url,
    });
    return {
      pending: true,
      branch: headBranch,
      pullRequest,
    };
  };

  const updateBranch = async (branch, branchSha, action = "updated", protectedUpdate) => {
    if (dryRun) {
      updates.push({ ref: branch, action: "dry-run", sha: branchSha });
      return { updated: true };
    }
    const currentSha = await readRefSha(`heads/${branch}`);
    if (currentSha === branchSha) {
      updates.push({ ref: branch, action: "existing", sha: branchSha });
      return { updated: true, existing: true };
    }
    try {
      if (currentSha) {
        await octokit.rest.git.updateRef({
          owner,
          repo,
          ref: `heads/${branch}`,
          sha: branchSha,
          force: false,
        });
        updates.push({ ref: branch, action, sha: branchSha });
      } else {
        await octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: branchSha,
        });
        updates.push({ ref: branch, action: "created", sha: branchSha });
      }
      return { updated: true };
    } catch (error) {
      if (protectedUpdate && protectedBranchUpdateRejected(error)) {
        return openVersionStatePullRequest({
          branch,
          branchSha,
          title: protectedUpdate.title,
          body: protectedUpdate.body,
        });
      }
      if (protectedUpdate?.allowNonFastForwardSkip && nonFastForwardUpdateRejected(error)) {
        updates.push({
          ref: branch,
          action: "skipped-non-fast-forward",
          sha: branchSha,
          currentSha,
        });
        return { updated: false, skipped: true, currentSha };
      }
      if (!notFound(error)) {
        throw error;
      }
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: branchSha,
      });
      updates.push({ ref: branch, action: "created", sha: branchSha });
      return { updated: true };
    }
  };

  const updateDefaultBranch = async (branch) => {
    if (dryRun) {
      updates.push({ ref: branch, action: "dry-run-default-branch" });
      return;
    }
    await octokit.rest.repos.update({
      owner,
      repo,
      default_branch: branch,
    });
    updates.push({ ref: branch, action: "updated-default-branch" });
  };

  const assertOnlyAllowedChangesBetween = async ({ baseSha, headSha, allowedPaths }) => {
    const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseSha}...${headSha}`,
    });
    const changedPaths = (comparison.files || []).map((file) => file.filename);
    const unexpected = changedPaths.filter((file) => !allowedPaths.includes(file));
    if (unexpected.length > 0) {
      throw new Error(
        `Version-state PR changed files outside declared version state: ${unexpected.join(", ")}`,
      );
    }
  };

  const assertPromotionPrOrVersionStateParent = async ({ commitSha, targetRef, allowedPaths }) => {
    try {
      await assertChannelPromotionPr({
        octokit,
        owner,
        repo,
        sha: commitSha,
        targetRef,
      });
      return;
    } catch (directError) {
      if (!allowedPaths?.length) {
        throw directError;
      }
      const { data: pullRequests } =
        await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: commitSha,
        });
      const matchingVersionStatePullRequest = pullRequests.find((pullRequest) => {
        const baseRef = pullRequest.base?.ref;
        const headRef = pullRequest.head?.ref;
        const headRepo = pullRequest.head?.repo?.full_name;
        return (
          pullRequest.merged_at &&
          baseRef === targetRef &&
          parseVersionStateBranchName(headRef) === targetRef &&
          headRepo === `${owner}/${repo}`
        );
      });
      const commit = await getCommitInfo(octokit, owner, repo, commitSha);
      if (matchingVersionStatePullRequest) {
        for (const parentSha of commit.parents) {
          try {
            await assertOnlyAllowedChangesBetween({
              baseSha: parentSha,
              headSha: commitSha,
              allowedPaths,
            });
            return;
          } catch {
            // Try the next parent before surfacing the original lineage failure.
          }
        }
        throw directError;
      }
      for (const parentSha of commit.parents) {
        try {
          await assertChannelPromotionPr({
            octokit,
            owner,
            repo,
            sha: parentSha,
            targetRef,
          });
          await assertOnlyAllowedChangesBetween({
            baseSha: parentSha,
            headSha: commitSha,
            allowedPaths,
          });
          return;
        } catch {
          // Try the next parent before surfacing the original lineage failure.
        }
      }
      throw directError;
    }
  };

  const assertReleasePrOrVersionStateParent = async ({
    commitSha,
    targetRef,
    alphaTag,
    alphaTreeSha,
    allowedPaths,
  }) => {
    const commit = await getCommitInfo(octokit, owner, repo, commitSha);
    if (commit.treeSha === alphaTreeSha) {
      await assertChannelPromotionPr({
        octokit,
        owner,
        repo,
        sha: commitSha,
        targetRef,
      });
      return;
    }
    for (const parentSha of commit.parents) {
      const parent = await getCommitInfo(octokit, owner, repo, parentSha);
      if (parent.treeSha !== alphaTreeSha) {
        continue;
      }
      await assertChannelPromotionPr({
        octokit,
        owner,
        repo,
        sha: parentSha,
        targetRef,
      });
      await assertOnlyAllowedChangesBetween({
        baseSha: parentSha,
        headSha: commitSha,
        allowedPaths,
      });
      return;
    }
    throw new Error(
      `Release source ${commitSha} must have the same tree as ${alphaTag}, except declared version-state files`,
    );
  };

  const isSettledAlphaVersionState = async (selectedAlpha) => {
    if (!selectedAlpha?.exists || selectedAlpha.sha !== sha) {
      return false;
    }
    const devRef = `heads/dev/v${rule.major}/v${rule.major}.${rule.minor}`;
    const [devSha, exactAlphaTagSha, floatingAlphaTagSha] = await Promise.all([
      readRefSha(devRef),
      readRefSha(`tags/${selectedAlpha.tag}`),
      readRefSha(`tags/${rule.alphaTag}`),
    ]);
    return (
      devSha === sha &&
      exactAlphaTagSha === sha &&
      floatingAlphaTagSha === sha
    );
  };

  const createVersionStateCommit = async ({ baseSha, version, message }) => {
    if (!versionState) {
      return {
        sha: baseSha,
        version,
        action: "disabled",
        files: [],
      };
    }

    const discovered = discoverVersionStateFiles(cwd);
    if (discovered.files.length === 0) {
      if (requireVersionState) {
        throw new Error("Strict promotion requires package version state");
      }
      updates.push({
        version,
        action: "skipped-no-version-state",
        packageManager: discovered.packageManager.name,
        sha: baseSha,
      });
      return {
        sha: baseSha,
        version,
        action: "skipped-no-version-state",
        files: [],
        packageManager: discovered.packageManager,
      };
    }

    const discoveredPaths = discovered.files.map((file) => file.path);
    const versionStrategy = getVersionStrategy(discovered.config);
    const anchorManifest = loadConfiguredAnchorManifest(cwd, discovered.config);
    const strategyEnv = versionVerificationEnv(versionStrategy, anchorManifest);
    const manualNext =
      versionStrategy.strategy === "anchored" && versionStrategy.next === "manual";
    const changedFiles = manualNext
      ? []
      : updateVersionStateContents(discovered.files, version);
    const changedPaths = changedFiles.map((file) => file.path);
    console.log(
      `> version state manager: ${discovered.packageManager.name} (${discovered.packageManager.reason})`,
    );
    console.log(
      `> version strategy: ${versionStrategy.strategy}/${versionStrategy.next}`,
    );
    if (anchorManifest) {
      console.log(`> anchor manifest: ${anchorManifest.path}`);
    }
    console.log(`> version state files: ${discoveredPaths.join(", ")}`);
    console.log(
      `> version state changes for ${version}: ${changedPaths.length ? changedPaths.join(", ") : "none"}`,
    );
    if (manualNext) {
      runVersionVerification({
        cwd,
        command: verificationCommand,
        loadedConfig: discovered.config,
        version,
        changedFiles: [],
        allowedPaths: discoveredPaths,
        env: strategyEnv,
      });
      updates.push({
        version,
        action: "anchored-manual-version-state",
        packageManager: discovered.packageManager.name,
        files: discoveredPaths,
        manifest: anchorManifest?.path,
        sha: baseSha,
      });
      return {
        sha: baseSha,
        version,
        action: "anchored-manual",
        files: discoveredPaths,
        packageManager: discovered.packageManager,
        versionStrategy,
        anchorManifest,
      };
    }
    if (changedFiles.length === 0) {
      runVersionVerification({
        cwd,
        command: verificationCommand,
        loadedConfig: discovered.config,
        version,
        changedFiles: [],
        allowedPaths: discoveredPaths,
        env: strategyEnv,
      });
      updates.push({
        version,
        action: "existing-version-state",
        packageManager: discovered.packageManager.name,
        files: discoveredPaths,
        sha: baseSha,
      });
      return {
        sha: baseSha,
        version,
        action: "existing",
        files: discoveredPaths,
        packageManager: discovered.packageManager,
        versionStrategy,
        anchorManifest,
      };
    }

    if (dryRun) {
      updates.push({
        version,
        action: "dry-run-version-state",
        packageManager: discovered.packageManager.name,
        files: changedFiles.map((file) => file.path),
        sha: baseSha,
      });
      return {
        sha: baseSha,
        version,
        action: "dry-run",
        files: changedFiles.map((file) => file.path),
        packageManager: discovered.packageManager,
        versionStrategy,
        anchorManifest,
      };
    }

    runVersionVerification({
      cwd,
      command: verificationCommand,
      loadedConfig: discovered.config,
      version,
      changedFiles,
      allowedPaths: discoveredPaths,
      env: strategyEnv,
    });

    const { data: baseCommit } = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: baseSha,
    });
    const tree = [];
    for (const file of changedFiles) {
      const { data: blob } = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: file.content,
        encoding: "utf-8",
      });
      tree.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }
    const { data: nextTree } = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.tree.sha,
      tree,
    });
    const { data: nextCommit } = await octokit.rest.git.createCommit({
      owner,
      repo,
      message,
      tree: nextTree.sha,
      parents: [baseSha],
      author: COMMIT_IDENTITY,
      committer: COMMIT_IDENTITY,
    });
    updates.push({
      version,
      action: "created-version-state",
      packageManager: discovered.packageManager.name,
      files: changedFiles.map((file) => file.path),
      sha: nextCommit.sha,
    });
    return {
      sha: nextCommit.sha,
      version,
      action: "created",
      files: changedFiles.map((file) => file.path),
      packageManager: discovered.packageManager,
      versionStrategy,
      anchorManifest,
    };
  };

  const shouldPromoteMajorTag = async () => {
    try {
      await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `tags/v${rule.major}.${rule.minor + 1}`,
      });
      return false;
    } catch (error) {
      if (notFound(error)) {
        return true;
      }
      throw error;
    }
  };

  let latestPublishTransaction;
  const executePublishTransaction = async ({
    version,
    exactTag,
    channel,
    line,
    releaseSha,
    allowVersionStateFinalization = false,
  }) => {
    if (dryRun && (publishTransaction || publishCommand || getLifecycleStage(loadBuildchainConfig(cwd), "publish"))) {
      updates.push({
        action: "dry-run-publish-transaction",
        version,
        tag: exactTag,
        sha: releaseSha,
      });
      return undefined;
    }
    latestPublishTransaction = await runPublishTransaction({
      octokit,
      owner,
      repo,
      cwd,
      loadedConfig: loadBuildchainConfig(cwd),
      targetRef,
      sourceSha: sha,
      releaseSha,
      version,
      exactTag,
      channel,
      line,
      publishTransaction,
      publishCommand,
      publishEvidencePath,
      transactionStatePath,
      publishRequiredArtifactsJson,
      releaseMaterialSha,
      publishToolingSha,
      actor,
      runId,
      explicitOverride: publishTransactionOverride,
      allowVersionStateFinalization,
    });
    if (latestPublishTransaction) {
      updates.push({
        action: "publish-transaction",
        version,
        tag: exactTag,
        sha: latestPublishTransaction.transaction.release_sha,
        state: latestPublishTransaction.transaction.state,
        transactionId: latestPublishTransaction.transaction.id,
        statePath: path.relative(cwd, latestPublishTransaction.statePath).split(path.sep).join("/"),
        evidencePath: path.relative(cwd, latestPublishTransaction.evidencePath).split(path.sep).join("/"),
        stateRef: latestPublishTransaction.transaction.state_ref,
        stateSha: latestPublishTransaction.durable?.sha,
      });
    }
    return latestPublishTransaction;
  };

  const markFinalizing = async () => {
    latestPublishTransaction = await beginTransactionFinalization(latestPublishTransaction, actor, runId);
  };

  const markComplete = async () => {
    latestPublishTransaction = await completeTransactionFinalization(latestPublishTransaction, actor, runId);
    return latestPublishTransaction;
  };

  const withPublishTransaction = (result, extra = {}) => {
    if (!latestPublishTransaction) {
      return result;
    }
    return {
      ...result,
      publishTransaction: {
        id: latestPublishTransaction.transaction.id,
        state: latestPublishTransaction.transaction.state,
        exactTag: latestPublishTransaction.transaction.exact_tag,
        releaseSha: latestPublishTransaction.transaction.release_sha,
        stateRef: latestPublishTransaction.transaction.state_ref,
        stateSha: latestPublishTransaction.durable?.sha,
        statePath: path.relative(cwd, latestPublishTransaction.statePath).split(path.sep).join("/"),
        evidencePath: path.relative(cwd, latestPublishTransaction.evidencePath).split(path.sep).join("/"),
        ...extra,
      },
    };
  };

  if (requireGovernance && !dryRun) {
    await assertProtectedChannel({
      octokit,
      owner,
      repo,
      targetRef,
      requiredStatusCheck,
    });
  }

  if (rule.channel === "major") {
    const resolveMajorGateSource = async () => {
      try {
        return await getMajorGateSource({
          octokit,
          owner,
          repo,
          sha,
          targetRef,
        });
      } catch (directError) {
        const commit = await getCommitInfo(octokit, owner, repo, sha);
        for (const parentSha of commit.parents) {
          try {
            return await getMajorGateSource({
              octokit,
              owner,
              repo,
              sha: parentSha,
              targetRef,
            });
          } catch {
            // Try the next parent before surfacing the direct lineage failure.
          }
        }
        throw directError;
      }
    };
    const majorGate = await resolveMajorGateSource();
    const majorRule = {
      ...rule,
      ...majorGate,
      tags: [majorGate.majorTag, majorGate.minorTag],
    };
    const refs = await listLineRefs(majorRule.releasePrefix);
    const explicitReleaseTags = requestedTags
      ? requestedTags.filter(
          (tag) =>
            !tag.includes("-alpha.") &&
            tag.startsWith(`${majorRule.releasePrefix}.`),
        )
      : [];
    if (explicitReleaseTags.length > 1) {
      throw new Error("publish-gate/major promotion accepts at most one explicit release tag");
    }
    const selectedRelease = explicitReleaseTags[0]
      ? {
          tag: explicitReleaseTags[0],
          patch: Number(explicitReleaseTags[0].split(".").pop()),
        }
      : selectReleaseTag({
          refs,
          releasePrefix: majorRule.releasePrefix,
          sha,
        });
    if (selectedRelease.patch !== 0) {
      throw new Error(
        `publish-gate/major promotion must create the first patch of the next major line; got ${selectedRelease.tag}`,
      );
    }
    const releaseVersion = stripTagPrefix(selectedRelease.tag);
    const releaseCommit = await createVersionStateCommit({
      baseSha: sha,
      version: releaseVersion,
      message: `chore(release): release ${selectedRelease.tag}`,
    });
    const releaseSha = releaseCommit.sha;
    if (requireGovernance && !dryRun) {
      if (releaseCommit.action === "existing") {
        await assertPromotionPrOrVersionStateParent({
          commitSha: sha,
          targetRef,
          allowedPaths: releaseCommit.files,
        });
      }
    }
    await executePublishTransaction({
      version: releaseVersion,
      exactTag: selectedRelease.tag,
      channel: majorRule.channel || "major",
      line: majorRule.releasePrefix,
      releaseSha,
      allowVersionStateFinalization: releaseCommit.action === "existing",
    });
    if (versionState) {
      await markFinalizing();
      const gateUpdate = await updateBranch(targetRef, releaseSha, "updated", {
        title: `Release ${selectedRelease.tag}`,
        body: `Create the generated version-state commit for ${selectedRelease.tag}.`,
      });
      if (gateUpdate.pending) {
        return withPublishTransaction({
          owner,
          repo,
          sourceSha: sha,
          sha: releaseSha,
          targetRef,
          pendingPullRequest: gateUpdate.pullRequest.html_url || gateUpdate.pullRequest.url,
          updates,
        }, { finalizationNeeded: true });
      }
      await updateBranch(`release/v${majorRule.major}/v${majorRule.major}.0`, releaseSha);
    }
    await markFinalizing();
    await ensureTag(selectedRelease.tag, releaseSha);
    await updateTag(majorRule.minorTag, releaseSha);
    await updateTag(majorRule.majorTag, releaseSha);
    await markComplete();

    if (releaseCommit.versionStrategy?.next === "manual") {
      updates.push({
        ref: `dev/v${majorRule.major}/v${majorRule.major}.0`,
        action: "next-anchor-required",
        versionStrategy: releaseCommit.versionStrategy.strategy,
        manifest: releaseCommit.anchorManifest?.path,
        sha: releaseSha,
      });
      return {
        owner,
        repo,
        sourceSha: sha,
        sha: releaseSha,
        nextAlphaRequired: true,
        targetRef,
        updates,
        publishTransaction: latestPublishTransaction
          ? {
              id: latestPublishTransaction.transaction.id,
              state: latestPublishTransaction.transaction.state,
              exactTag: latestPublishTransaction.transaction.exact_tag,
              releaseSha: latestPublishTransaction.transaction.release_sha,
              stateRef: latestPublishTransaction.transaction.state_ref,
              stateSha: latestPublishTransaction.durable?.sha,
              statePath: path.relative(cwd, latestPublishTransaction.statePath).split(path.sep).join("/"),
              evidencePath: path.relative(cwd, latestPublishTransaction.evidencePath).split(path.sep).join("/"),
            }
          : undefined,
      };
    }

    const explicitAlphaTags = requestedTags
      ? requestedTags.filter((tag) => tag.includes("-alpha."))
      : [];
    if (explicitAlphaTags.length > 1) {
      throw new Error(
        "publish-gate/major promotion accepts at most one explicit next-alpha tag",
      );
    }
    const selectedNextAlpha = explicitAlphaTags[0]
      ? { tag: explicitAlphaTags[0] }
      : selectAlphaTag({
          refs,
          releasePrefix: majorRule.releasePrefix,
          sha: releaseSha,
          patchAfterRelease: 1,
        });
    const nextAlphaVersion = stripTagPrefix(selectedNextAlpha.tag);
    let nextAlphaSha = versionState ? selectedNextAlpha.sha : sha;
    if (versionState && selectedNextAlpha.exists && nextAlphaSha) {
      updates.push({
        version: nextAlphaVersion,
        action: "existing-version-state",
        sha: nextAlphaSha,
      });
    } else if (versionState) {
      const nextAlphaCommit = await createVersionStateCommit({
        baseSha: releaseSha,
        version: nextAlphaVersion,
        message: `chore(release): prepare ${selectedNextAlpha.tag}`,
      });
      nextAlphaSha = nextAlphaCommit.sha;
    }
    if (versionState) {
      await updateBranch(`alpha/v${majorRule.major}/v${majorRule.major}.0`, nextAlphaSha);
      const nextDevRef = `dev/v${majorRule.major}/v${majorRule.major}.0`;
      await updateBranch(nextDevRef, nextAlphaSha);
      await updateDefaultBranch(nextDevRef);
    }
    await ensureTag(selectedNextAlpha.tag, nextAlphaSha);
    await updateTag(majorRule.alphaTag, nextAlphaSha);
    return withPublishTransaction({
      owner,
      repo,
      sourceSha: sha,
      sha: releaseSha,
      nextAlphaSha,
      targetRef,
      updates,
    });
  }

  const lineRefs = await listLineRefs();

  if (rule.channel === "alpha") {
    const explicitAlphaTags = requestedTags
      ? requestedTags.filter((tag) => tag.includes("-alpha."))
      : [];
    if (explicitAlphaTags.length > 1) {
      throw new Error(
        "Alpha promotion accepts at most one explicit prerelease tag",
      );
    }
    const currentAlpha = explicitAlphaTags[0]
      ? undefined
      : currentAlphaVersionState({
          cwd,
          refs: lineRefs,
          releasePrefix: rule.releasePrefix,
        });
    const currentAlphaTagSha = currentAlpha
      ? await readRefSha(`tags/${currentAlpha.tag}`)
      : undefined;
    let selectedAlpha = explicitAlphaTags[0]
      ? { tag: explicitAlphaTags[0] }
      : currentAlpha && !currentAlphaTagSha
        ? currentAlpha
        : selectAlphaTag({
            refs: lineRefs,
            releasePrefix: rule.releasePrefix,
            sha,
          });
    const settledAlphaVersionState = await isSettledAlphaVersionState(selectedAlpha);
    if (settledAlphaVersionState) {
      updates.push({ ref: targetRef, action: "already-promoted", sha });
      updates.push({
        ref: `dev/v${rule.major}/v${rule.major}.${rule.minor}`,
        action: "already-promoted",
        sha,
      });
      updates.push({ tag: selectedAlpha.tag, action: "existing", sha });
      updates.push({ tag: rule.alphaTag, action: "existing", sha });
      return { owner, repo, sourceSha: sha, sha, targetRef, updates };
    }
    const prepareAlphaCommit = async (candidate) => {
      const version = stripTagPrefix(candidate.tag);
      const commit = await createVersionStateCommit({
        baseSha: sha,
        version,
        message: `chore(release): prepare ${candidate.tag}`,
      });
      if (requireGovernance && !dryRun) {
        await assertPromotionPrOrVersionStateParent({
          commitSha: sha,
          targetRef,
          allowedPaths: commit.files,
        });
      }
      return { version, commit, sha: commit.sha };
    };
    let alpha = await prepareAlphaCommit(selectedAlpha);
    try {
      await executePublishTransaction({
        version: alpha.version,
        exactTag: selectedAlpha.tag,
        channel: rule.channel,
        line: rule.releasePrefix,
        releaseSha: alpha.sha,
        allowVersionStateFinalization:
          currentAlpha &&
          !currentAlphaTagSha &&
          selectedAlpha.tag === currentAlpha.tag &&
          alpha.commit.action === "existing",
      });
    } catch (error) {
      const staleCurrentAlpha =
        currentAlpha &&
        !currentAlphaTagSha &&
        selectedAlpha.tag === currentAlpha.tag &&
        /release transaction identity mismatch/.test(error.message || "");
      if (!staleCurrentAlpha) {
        throw error;
      }
      updates.push({
        tag: selectedAlpha.tag,
        action: "stale-publish-transaction",
        sha: alpha.sha,
      });
      selectedAlpha = selectAlphaTag({
        refs: lineRefs,
        releasePrefix: rule.releasePrefix,
        sha,
      });
      alpha = await prepareAlphaCommit(selectedAlpha);
      await executePublishTransaction({
        version: alpha.version,
        exactTag: selectedAlpha.tag,
        channel: rule.channel,
        line: rule.releasePrefix,
        releaseSha: alpha.sha,
      });
    }
    if (versionState) {
      await markFinalizing();
      const targetUpdate = await updateBranch(targetRef, alpha.sha, "updated", {
        title: `Prepare ${selectedAlpha.tag}`,
        body: `Create the generated version-state commit for ${selectedAlpha.tag}.`,
      });
      if (targetUpdate.pending) {
        return withPublishTransaction({
          owner,
          repo,
          sourceSha: sha,
          sha: alpha.sha,
          targetRef,
          pendingPullRequest: targetUpdate.pullRequest.html_url || targetUpdate.pullRequest.url,
          updates,
        }, { finalizationNeeded: true });
      }
      await updateBranch(
        `dev/v${rule.major}/v${rule.major}.${rule.minor}`,
        alpha.sha,
        "updated",
        { allowNonFastForwardSkip: true },
      );
    }
    await markFinalizing();
    await ensureTag(selectedAlpha.tag, alpha.sha);
    await updateTag(rule.alphaTag, alpha.sha);
    await markComplete();
    return withPublishTransaction({ owner, repo, sourceSha: sha, sha: alpha.sha, targetRef, updates });
  }

  const explicitReleaseTags = requestedTags
    ? requestedTags.filter(
        (tag) =>
          !tag.includes("-alpha.") && tag.startsWith(`${rule.releasePrefix}.`),
      )
    : [];
  if (explicitReleaseTags.length > 1) {
    throw new Error("Release promotion accepts at most one explicit patch tag");
  }
  const selectedRelease = explicitReleaseTags[0]
    ? {
        tag: explicitReleaseTags[0],
        patch: Number(explicitReleaseTags[0].split(".").pop()),
      }
    : selectReleaseTag({
        refs: lineRefs,
        releasePrefix: rule.releasePrefix,
        sha,
      });
  const sourceAlpha = latestAlphaForPatch(
    lineRefs,
    rule.releasePrefix,
    selectedRelease.patch,
  );
  const releaseVersion = stripTagPrefix(selectedRelease.tag);
  const releaseCommit = await createVersionStateCommit({
    baseSha: sha,
    version: releaseVersion,
    message: `chore(release): release ${selectedRelease.tag}`,
  });
  const releaseSha = releaseCommit.sha;
  if (requireGovernance && !dryRun) {
    if (!sourceAlpha?.sha) {
      throw new Error(
        `Release promotion requires an existing ${rule.releasePrefix}.${selectedRelease.patch}-alpha.N tag`,
      );
    }
    const alphaCommit = await getCommitInfo(octokit, owner, repo, sourceAlpha.sha);
    await assertReleasePrOrVersionStateParent({
      commitSha: releaseSha,
      targetRef,
      alphaTag: sourceAlpha.tag,
      alphaTreeSha: alphaCommit.treeSha,
      allowedPaths: releaseCommit.files,
    });
  }
  await executePublishTransaction({
    version: releaseVersion,
    exactTag: selectedRelease.tag,
    channel: rule.channel,
    line: rule.releasePrefix,
    releaseSha,
    allowVersionStateFinalization: releaseCommit.action === "existing",
  });
  if (versionState) {
    await markFinalizing();
    const targetUpdate = await updateBranch(targetRef, releaseSha, "updated", {
      title: `Release ${selectedRelease.tag}`,
      body: `Create the generated version-state commit for ${selectedRelease.tag}.`,
    });
    if (targetUpdate.pending) {
      return withPublishTransaction({
        owner,
        repo,
        sourceSha: sha,
        sha: releaseSha,
        targetRef,
        pendingPullRequest: targetUpdate.pullRequest.html_url || targetUpdate.pullRequest.url,
        updates,
      }, { finalizationNeeded: true });
    }
  }
  await markFinalizing();
  await ensureTag(selectedRelease.tag, releaseSha);
  await updateTag(rule.minorTag, releaseSha);
  if (await shouldPromoteMajorTag()) {
    await updateTag(rule.majorTag, releaseSha);
  } else {
    updates.push({
      tag: rule.majorTag,
      action: "skipped-next-minor-exists",
      sha: releaseSha,
    });
  }
  await markComplete();

  if (releaseCommit.versionStrategy?.next === "manual") {
    updates.push({
      ref: `dev/v${rule.major}/v${rule.major}.${rule.minor}`,
      action: "next-anchor-required",
      versionStrategy: releaseCommit.versionStrategy.strategy,
      manifest: releaseCommit.anchorManifest?.path,
      sha: releaseSha,
    });
    return withPublishTransaction({
      owner,
      repo,
      sourceSha: sha,
      sha: releaseSha,
      nextAlphaRequired: true,
      targetRef,
      updates,
    });
  }

  const explicitAlphaTags = requestedTags
    ? requestedTags.filter((tag) => tag.includes("-alpha."))
    : [];
  if (explicitAlphaTags.length > 1) {
    throw new Error(
      "Release promotion accepts at most one explicit next-alpha tag",
    );
  }
  const selectedNextAlpha = explicitAlphaTags[0]
    ? { tag: explicitAlphaTags[0] }
    : selectAlphaTag({
        refs: lineRefs,
        releasePrefix: rule.releasePrefix,
        sha: releaseSha,
        patchAfterRelease: selectedRelease.patch + 1,
      });
  const nextAlphaVersion = stripTagPrefix(selectedNextAlpha.tag);
  let nextAlphaSha = versionState ? selectedNextAlpha.sha : sha;
  if (versionState && selectedNextAlpha.exists && nextAlphaSha) {
    updates.push({
      version: nextAlphaVersion,
      action: "existing-version-state",
      sha: nextAlphaSha,
    });
  } else if (versionState) {
    const nextAlphaCommit = await createVersionStateCommit({
      baseSha: releaseSha,
      version: nextAlphaVersion,
      message: `chore(release): prepare ${selectedNextAlpha.tag}`,
    });
    nextAlphaSha = nextAlphaCommit.sha;
  }
  if (versionState) {
    const nextAlphaRef = `alpha/v${rule.major}/v${rule.major}.${rule.minor}`;
    const nextAlphaUpdate = await updateBranch(nextAlphaRef, nextAlphaSha, "updated", {
      title: `Prepare ${selectedNextAlpha.tag}`,
      body: `Create the generated version-state commit for ${selectedNextAlpha.tag}.`,
    });
    if (nextAlphaUpdate.pending) {
      return withPublishTransaction({
        owner,
        repo,
        sourceSha: sha,
        sha: releaseSha,
        nextAlphaSha,
        targetRef,
        pendingPullRequest:
          nextAlphaUpdate.pullRequest.html_url || nextAlphaUpdate.pullRequest.url,
        updates,
      });
    }
    await updateBranch(`dev/v${rule.major}/v${rule.major}.${rule.minor}`, nextAlphaSha);
  }
  await ensureTag(selectedNextAlpha.tag, nextAlphaSha);
  await updateTag(rule.alphaTag, nextAlphaSha);
  return withPublishTransaction({
    owner,
    repo,
    sourceSha: sha,
    sha: releaseSha,
    nextAlphaSha,
    targetRef,
    updates,
  });
}

export {
  DEFAULT_REPOSITORY,
  assertChannelPromotionPr,
  assertAllowedLocalChanges,
  assertProtectedChannel,
  assertPromotableRepository,
  assertPromotableTargetRef,
  assertSha,
  discoverVersionStateFiles,
  expectedHeadRefForTarget,
  getPromotionRule,
  latestAlphaForPatch,
  parseReleaseLineRef,
  parseAlphaPrereleaseTag,
  parseRepository,
  parseReleasePatchTag,
  parseTags,
  promoteBuildchainRefs,
  persistDurableReleaseTransaction,
  restoreDurableReleaseTransaction,
  resolveTagsForTarget,
  selectAlphaTag,
  selectReleaseTag,
  stripTagPrefix,
  updateVersionStateContents,
};
