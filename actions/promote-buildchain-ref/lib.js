const DEFAULT_REPOSITORY = "kungfu-systems/buildchain";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import {
  detectPackageManager,
  getWorkspaceInfo,
} from "../../packages/core/package-manager.js";
import {
  discoverConfiguredVersionStateFiles,
  getPublishContract,
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
const RELEASE_LINE_RECOVERY_PATHS = [
  "actions/promote-buildchain-ref/",
  "scripts/release-line-policy.mjs",
  "tests/promote-buildchain-ref.test.mjs",
  "tests/release-line-policy.test.mjs",
];

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

function parseReleaseLineRecoveryRef(ref) {
  const match = String(ref || "").match(/^fix\/release-line-v(\d+)-v(\d+)\.(\d+)-[0-9A-Za-z._-]+$/);
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  const minorMajor = Number(match[2]);
  const minor = Number(match[3]);
  if (major !== minorMajor) {
    throw new Error(`Release recovery ref major mismatch: ${ref}`);
  }
  return {
    ref,
    major,
    minor,
    targetRef: `release/v${major}/v${major}.${minor}`,
  };
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

function readConfiguredVersionValue(file) {
  if (file.type === "json" || file.type === "toml") {
    return String(file.key)
      .split(".")
      .reduce((current, segment) => current?.[segment], file.content);
  }
  if (file.type === "regex") {
    return file.source.match(file.pattern)?.groups?.version;
  }
  return undefined;
}

function currentConfiguredVersion(files) {
  const versions = [
    ...new Set(
      files
        .map((file) => readConfiguredVersionValue(file))
        .filter((version) => typeof version === "string" && version.trim() !== ""),
    ),
  ];
  if (versions.length === 0) {
    return undefined;
  }
  if (versions.length > 1) {
    throw new Error(
      `Configured version files disagree: ${versions.join(", ")}`,
    );
  }
  return versions[0];
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
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

function npmPackageSpec(artifact) {
  return `${artifact.name}@${artifact.ref}`;
}

function isAlphaLikeVersion(version) {
  return /(?:^|[-.])alpha(?:[-.]|$)/i.test(String(version || ""));
}

function defaultDistTagForChannel(channel) {
  return channel === "alpha" ? "alpha" : "latest";
}

function resolvePublishContract({
  loadedConfig,
  channel,
  publishMode = "",
  publishAuth = "",
  publishDistTag = "",
  publishPackageSetOrder = "",
  publishPackageMain = "",
} = {}) {
  const configured = getPublishContract(loadedConfig) || {};
  const mode = publishMode || configured.mode || "publish-final-version";
  const auth = publishAuth || configured.auth || "trusted-publishing";
  const packageSetOrder = publishPackageSetOrder || configured.packageSetOrder || "as-provided";
  const mainPackage = publishPackageMain || configured.mainPackage || "";
  const distTag = publishDistTag || configured.distTag || defaultDistTagForChannel(channel);
  if (!["publish-final-version", "promote-existing-version"].includes(mode)) {
    throw new Error("publish mode must be one of publish-final-version or promote-existing-version");
  }
  if (!["trusted-publishing", "npm-token"].includes(auth)) {
    throw new Error("publish auth must be one of trusted-publishing or npm-token");
  }
  if (!["as-provided", "platforms-first-main-last"].includes(packageSetOrder)) {
    throw new Error("publish package set order must be one of as-provided or platforms-first-main-last");
  }
  if (mode === "promote-existing-version" && auth !== "npm-token") {
    throw new Error("promote-existing-version requires npm-token auth; Trusted Publishing cannot authorize npm dist-tag add");
  }
  if (channel === "release" && mode === "publish-final-version" && distTag !== "latest") {
    throw new Error("release publish-final-version must use dist-tag latest");
  }
  if (channel === "alpha" && mode === "publish-final-version" && distTag !== "alpha") {
    throw new Error("alpha publish-final-version must use dist-tag alpha");
  }
  return {
    mode,
    auth,
    distTag,
    packageSetOrder,
    mainPackage,
  };
}

function allRequiredArtifactsAreNpm(requiredArtifacts) {
  return (
    requiredArtifacts.length > 0 &&
    requiredArtifacts.every(
      (artifact) => artifact.kind === "npm" && artifact.name && artifact.ref,
    )
  );
}

function orderNpmArtifactsForPackageSet({ artifacts, contract }) {
  if (contract.packageSetOrder !== "platforms-first-main-last") {
    return artifacts;
  }
  const mainPackage = contract.mainPackage;
  return [
    ...artifacts.filter((artifact) => artifact.role !== "main" && artifact.name !== mainPackage),
    ...artifacts.filter((artifact) => artifact.role === "main" || artifact.name === mainPackage),
  ];
}

function validatePublishContractForArtifacts({ channel, contract, requiredArtifacts }) {
  if (contract.mode === "promote-existing-version" && !allRequiredArtifactsAreNpm(requiredArtifacts)) {
    throw new Error("promote-existing-version requires npm publish-required-artifacts-json entries");
  }
  if (contract.packageSetOrder === "platforms-first-main-last") {
    const mainArtifacts = requiredArtifacts.filter(
      (artifact) => artifact.role === "main" || artifact.name === contract.mainPackage,
    );
    if (mainArtifacts.length !== 1) {
      throw new Error("platforms-first-main-last package set requires exactly one main npm artifact");
    }
  }
  if (channel === "release" && contract.mode === "publish-final-version") {
    const alphaArtifacts = requiredArtifacts.filter((artifact) => isAlphaLikeVersion(artifact.ref));
    if (alphaArtifacts.length > 0) {
      throw new Error("release publish-final-version must publish final package refs, not alpha refs");
    }
  }
}

function readExistingNpmIntegrity({ cwd, artifact }) {
  const spec = npmPackageSpec(artifact);
  try {
    const output = execFileSync(
      "npm",
      ["view", spec, "dist.integrity", "--json"],
      {
        cwd,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (!output) {
      throw new Error("empty dist.integrity");
    }
    return JSON.parse(output);
  } catch (error) {
    const message = error.stderr?.toString?.().trim() || error.message;
    throw new Error(`existing npm artifact is required for release promotion: ${spec}: ${message}`);
  }
}

function resolveExistingNpmArtifacts({ cwd, requiredArtifacts }) {
  return requiredArtifacts.map((artifact) => ({
    ...artifact,
    digest: readExistingNpmIntegrity({ cwd, artifact }),
  }));
}

function writeExistingNpmEvidence({
  evidencePath,
  version,
  channel,
  sourceSha,
  releaseSha,
  targetRef,
  releaseMaterialSha,
  publishToolingSha,
  artifacts,
}) {
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
}

function npmTokenLooksConfigured() {
  return Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || process.env.npm_config__authToken);
}

function preflightNpmTokenAuth({ cwd, registry = "https://registry.npmjs.org/" } = {}) {
  if (!npmTokenLooksConfigured()) {
    throw new Error("promote-existing-version requires npm token auth before dist-tag promotion; set NODE_AUTH_TOKEN or NPM_TOKEN");
  }
  try {
    execFileSync("npm", ["whoami", `--registry=${registry}`], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error.stderr?.toString?.().trim() || error.message;
    throw new Error(`promote-existing-version npm token preflight failed: npm whoami failed: ${message}`);
  }
}

function npmDistTagAlreadyPoints({ cwd, artifact, distTag }) {
  try {
    const output = execFileSync(
      "npm",
      ["view", artifact.name, `dist-tags.${distTag}`, "--json"],
      {
        cwd,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (!output) {
      return false;
    }
    return JSON.parse(output) === artifact.ref;
  } catch {
    return false;
  }
}

function promoteExistingNpmArtifacts({ cwd, artifacts, distTag }) {
  const promoted = new Set();
  for (const artifact of artifacts) {
    const spec = npmPackageSpec(artifact);
    const key = `${spec}\0${distTag}`;
    if (promoted.has(key)) {
      continue;
    }
    if (npmDistTagAlreadyPoints({ cwd, artifact, distTag })) {
      promoted.add(key);
      continue;
    }
    execFileSync("npm", ["dist-tag", "add", spec, distTag], {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    promoted.add(key);
  }
  return "existing-npm-artifacts";
}

function materialErrorRequiresRepair(error) {
  return /release_material_sha mismatch|source_sha mismatch|release_sha mismatch|version mismatch|target_ref mismatch|artifact digest mismatch|required artifact missing/.test(
    error.message || "",
  );
}

function ensureTransactionCanResume({
  existing,
  expected,
  explicitOverride,
  evidence,
  validation,
}) {
  if (!existing) {
    return;
  }
  assertTransactionIdentity(existing, expected, { allowToolingDrift: true });
  const recovery = planTransactionRecovery({
    transaction: existing,
    evidence,
    validation,
    explicitOverride,
  });
  if (recovery.blocked) {
    throw new Error(`release transaction cannot resume: ${recovery.reason}`);
  }
}

function canReplaceStaleVersionStateTransaction({
  error,
  existing,
  version,
  exactTag,
  targetRef,
  channel,
  allowVersionStateFinalization,
  localOnly,
}) {
  if (!materialErrorRequiresRepair(error)) {
    return false;
  }
  if (localOnly) {
    return true;
  }
  if (!allowVersionStateFinalization) {
    return false;
  }
  if (
    existing?.version !== version ||
    existing?.exact_tag !== exactTag ||
    existing?.target_ref !== targetRef ||
    existing?.channel !== channel
  ) {
    return false;
  }
  return !["complete", "abandoned", "failed_permanently"].includes(existing.state || "");
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
  const record = await readDurableReleaseTransaction({
    octokit,
    owner,
    repo,
    stateRef,
  });
  if (!record) {
    return undefined;
  }
  writeReleaseTransaction(statePath, record);

  const ref = await getGitRefOrUndefined({
    octokit,
    owner,
    repo,
    ref: `heads/${stateRef}`,
  });
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

async function readDurableReleaseTransaction({
  octokit,
  owner,
  repo,
  stateRef,
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
  return JSON.parse(decodeGitBlob(stateBlob));
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
  const seen = new Set();
  const queue = [releaseSha];
  while (queue.length > 0 && seen.size < 64) {
    const sha = queue.shift();
    if (!sha || seen.has(sha)) {
      continue;
    }
    if (sha === transactionReleaseSha) {
      return true;
    }
    seen.add(sha);
    const { data: commit } = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: sha,
    });
    for (const parent of commit.parents || []) {
      if (!seen.has(parent.sha)) {
        queue.push(parent.sha);
      }
    }
  }
  return false;
}

function uniqueShas(values) {
  return [...new Set(values.filter(Boolean))];
}

function transactionAcceptedExactTagShas(transaction, publicSha) {
  return uniqueShas([
    publicSha,
    transaction?.release_sha,
    transaction?.release_material_sha,
  ]);
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
  publishMode = "",
  publishAuth = "",
  publishDistTag = "",
  publishPackageSetOrder = "",
  publishPackageMain = "",
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
  let requiredArtifacts = parsePublishArtifactsJson(
    publishRequiredArtifactsJson,
    "publish-required-artifacts-json",
  );
  const publishContract = resolvePublishContract({
    loadedConfig,
    channel,
    publishMode,
    publishAuth,
    publishDistTag,
    publishPackageSetOrder,
    publishPackageMain,
  });
  validatePublishContractForArtifacts({
    channel,
    contract: publishContract,
    requiredArtifacts,
  });
  const existingNpmPromotion = publishContract.mode === "promote-existing-version";
  if (existingNpmPromotion) {
    preflightNpmTokenAuth({ cwd });
  }
  requiredArtifacts = orderNpmArtifactsForPackageSet({
    artifacts: requiredArtifacts,
    contract: publishContract,
  });
  if (existingNpmPromotion) {
    requiredArtifacts = resolveExistingNpmArtifacts({ cwd, requiredArtifacts });
    requiredArtifacts = orderNpmArtifactsForPackageSet({
      artifacts: requiredArtifacts,
      contract: publishContract,
    });
  }
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
  let existing = durableExisting || localExisting;
  let existingEvidence = readPublishEvidence(resolvedEvidencePath);
  let existingValidation;
  if (existingEvidence) {
    existingValidation = validatePublishEvidence({
      evidence: existingEvidence,
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
  let versionStateFinalization = false;
  try {
    ensureTransactionCanResume({
      existing,
      expected,
      explicitOverride,
      evidence: existingEvidence,
      validation: existingValidation,
    });
  } catch (error) {
    const canFinalizeVersionState =
      allowVersionStateFinalization &&
      materialErrorRequiresRepair(error) &&
      existing?.version === version &&
      existing?.exact_tag === exactTag &&
      existing?.target_ref === targetRef &&
      ["published", "finalizing", "complete"].includes(existing.state || "") &&
      (
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha,
          transactionReleaseSha: existing.release_sha,
        }) ||
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha,
          transactionReleaseSha: existing.release_material_sha,
        })
      );
    const canReplaceStaleVersionState =
      canReplaceStaleVersionStateTransaction({
        error,
        existing,
        version,
        exactTag,
        targetRef,
        channel,
        allowVersionStateFinalization,
        localOnly: Boolean(localExisting && !durableExisting),
      });
    if (!canFinalizeVersionState && !canReplaceStaleVersionState) {
      throw error;
    }
    if (canFinalizeVersionState) {
      versionStateFinalization = true;
    } else {
      existing = undefined;
      existingEvidence = undefined;
      existingValidation = undefined;
      fs.rmSync(resolvedStatePath, { force: true });
      fs.rmSync(resolvedEvidencePath, { force: true });
    }
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
    const evidence = existingEvidence || readPublishEvidence(resolvedEvidencePath);
    if (evidence) {
      validation = existingValidation;
    }
    if (evidence && !validation) {
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
      let source;
      if (existingNpmPromotion) {
        source = promoteExistingNpmArtifacts({
          cwd,
          artifacts: requiredArtifacts,
          distTag: publishContract.distTag,
        });
        writeExistingNpmEvidence({
          evidencePath: resolvedEvidencePath,
          version,
          channel,
          sourceSha,
          releaseSha,
          targetRef,
          releaseMaterialSha: expected.releaseMaterialSha,
          publishToolingSha: expected.publishToolingSha,
          artifacts: requiredArtifacts,
        });
      } else {
        source = runPublishCommand({
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
            BUILDCHAIN_PUBLISH_MODE: publishContract.mode,
            BUILDCHAIN_PUBLISH_AUTH: publishContract.auth,
            BUILDCHAIN_NPM_DIST_TAG: publishContract.distTag,
            BUILDCHAIN_PACKAGE_SET_ORDER: publishContract.packageSetOrder,
            BUILDCHAIN_PACKAGE_SET_MAIN_PACKAGE: publishContract.mainPackage,
          },
        });
      }
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
    if (["published", "finalizing", "complete"].includes(transaction.state)) {
      try {
        transaction = transitionReleaseTransaction(transaction, transaction.state, {
          actor,
          runId,
          failure: error.message,
        });
        await persistTransaction(transaction);
      } catch (persistError) {
        error.message = `${error.message}; additionally failed to preserve post-publish transaction state: ${persistError.message}`;
      }
      throw error;
    }
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

function currentReleaseVersionState({ cwd, refs, releasePrefix }) {
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
  const parsed = parseReleasePatchTag(`refs/tags/v${versions[0]}`, releasePrefix);
  if (!parsed) {
    return undefined;
  }
  const stateRef = `refs/heads/${releaseTransactionStateRef(versions[0])}`;
  const hasDurableState = refs.some((ref) => ref.ref === stateRef);
  if (!hasDurableState) {
    return undefined;
  }
  return {
    ...parsed,
    tag: `v${versions[0]}`,
    version: versions[0],
  };
}

async function readDurableTransactionForVersion({ octokit, owner, repo, version }) {
  if (!version) {
    return undefined;
  }
  try {
    return await readDurableReleaseTransaction({
      octokit,
      owner,
      repo,
      stateRef: releaseTransactionStateRef(version),
    });
  } catch (error) {
    const message = error?.message || "";
    if (notFound(error) || /missing state\.json|getTree is not a function/i.test(message)) {
      return undefined;
    }
    throw error;
  }
}

async function resumableAlphaTransactionState({
  octokit,
  owner,
  repo,
  cwd,
  refs,
  releasePrefix,
  targetRef,
  sourceSha,
}) {
  const candidates = refs
    .map((ref) => parseAlphaPrereleaseRef(ref.ref, releasePrefix))
    .filter((ref) => ref?.source === "release-state")
    .sort((a, b) => b.patch - a.patch || b.prerelease - a.prerelease);
  for (const candidate of candidates) {
    const version = stripTagPrefix(candidate.tag);
    let transaction;
    try {
      transaction = await readDurableReleaseTransaction({
        octokit,
        owner,
        repo,
        stateRef: releaseTransactionStateRef(version),
      });
    } catch (error) {
      const message = error?.message || "";
      if (notFound(error) || /missing state\.json/i.test(message)) {
        continue;
      }
      throw error;
    }
    if (
      transaction &&
      transaction.target_ref === targetRef &&
      transaction.exact_tag === candidate.tag &&
      !["complete", "abandoned", "failed_permanently"].includes(transaction.state) &&
      (
        transaction.source_sha === sourceSha ||
        transaction.release_sha === sourceSha ||
        transaction.release_material_sha === sourceSha ||
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sourceSha,
          transactionReleaseSha: transaction.release_sha,
        }) ||
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sourceSha,
          transactionReleaseSha: transaction.release_material_sha,
        })
      )
    ) {
      return {
        ...candidate,
        version,
        transaction,
      };
    }
  }
  return undefined;
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
  publishMode = "",
  publishAuth = "",
  publishDistTag = "",
  publishPackageSetOrder = "",
  publishPackageMain = "",
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

  const ensureTag = async (tag, tagSha = sha, options = {}) => {
    const acceptedExistingShas = uniqueShas([
      tagSha,
      ...(options.acceptedExistingShas || []),
    ]);
    const acceptedExistingMaterialShas = uniqueShas(
      options.acceptedExistingMaterialShas || [],
    );
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
      let acceptedExistingMaterial = false;
      for (const materialSha of acceptedExistingMaterialShas) {
        if (await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: tagRef.object.sha,
          transactionReleaseSha: materialSha,
        })) {
          acceptedExistingMaterial = true;
          break;
        }
      }
      if (!acceptedExistingShas.includes(tagRef.object.sha) && !acceptedExistingMaterial) {
        throw new Error(
          `Tag ${tag} points at ${tagRef.object.sha}, not one of requested SHAs ${acceptedExistingShas.join(", ")}`,
        );
      }
      updates.push({ tag, action: "existing", sha: tagRef.object.sha });
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
    if (typeof octokit.rest.repos?.update !== "function") {
      updates.push({ ref: branch, action: "skipped-default-branch-update-unavailable" });
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

  const assertOnlyAllowedReleaseRecoveryChangesBetween = async ({
    baseSha,
    headSha,
    allowedPaths = [],
  }) => {
    const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseSha}...${headSha}`,
    });
    const changedPaths = (comparison.files || []).map((file) => file.filename);
    const unexpected = changedPaths.filter((file) => {
      if (allowedPaths.includes(file)) {
        return false;
      }
      return !RELEASE_LINE_RECOVERY_PATHS.some((allowedPath) =>
        allowedPath.endsWith("/") ? file.startsWith(allowedPath) : file === allowedPath,
      );
    });
    if (unexpected.length > 0) {
      throw new Error(
        `Release-line recovery PR changed files outside buildchain recovery scope: ${unexpected.join(", ")}`,
      );
    }
  };

  const findMatchingReleaseRecoveryPullRequest = async ({ commitSha, targetRef }) => {
    const { data: pullRequests } =
      await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: commitSha,
      });
    return pullRequests.find((pullRequest) => {
      const baseRef = pullRequest.base?.ref;
      const headRef = pullRequest.head?.ref;
      const headRepo = pullRequest.head?.repo?.full_name;
      const recovery = parseReleaseLineRecoveryRef(headRef);
      return (
        pullRequest.merged_at &&
        baseRef === targetRef &&
        recovery?.targetRef === targetRef &&
        headRepo === `${owner}/${repo}`
      );
    });
  };

  const findMatchingTargetPullRequest = async ({ commitSha, targetRef }) => {
    const { data: pullRequests } =
      await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: commitSha,
      });
    return pullRequests.find((pullRequest) => {
      const baseRef = pullRequest.base?.ref;
      const headRepo = pullRequest.head?.repo?.full_name;
      return (
        pullRequest.merged_at &&
        baseRef === targetRef &&
        headRepo === `${owner}/${repo}`
      );
    });
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
    alphaSha,
    alphaTag,
    alphaTreeSha,
    allowedPaths,
    allowDirectAllowedChanges = false,
  }) => {
    const commit = await getCommitInfo(octokit, owner, repo, commitSha);
    if (commit.treeSha === alphaTreeSha) {
      try {
        await assertChannelPromotionPr({
          octokit,
          owner,
          repo,
          sha: commitSha,
          targetRef,
        });
      } catch (error) {
        const matchingReleaseRecoveryPullRequest =
          await findMatchingReleaseRecoveryPullRequest({ commitSha, targetRef });
        if (!matchingReleaseRecoveryPullRequest) {
          throw error;
        }
        await assertOnlyAllowedReleaseRecoveryChangesBetween({
          baseSha: alphaSha,
          headSha: commitSha,
          allowedPaths,
        });
      }
      return;
    }
    if (allowDirectAllowedChanges && allowedPaths?.length) {
      let validPromotionPr = false;
      try {
        await assertChannelPromotionPr({
          octokit,
          owner,
          repo,
          sha: commitSha,
          targetRef,
        });
        validPromotionPr = true;
        await assertOnlyAllowedChangesBetween({
          baseSha: alphaSha,
          headSha: commitSha,
          allowedPaths,
        });
        return;
      } catch (error) {
        if (validPromotionPr) {
          throw error;
        }
      }
      const matchingTargetPullRequest = await findMatchingTargetPullRequest({
        commitSha,
        targetRef,
      });
      if (matchingTargetPullRequest) {
        await assertOnlyAllowedChangesBetween({
          baseSha: alphaSha,
          headSha: commitSha,
          allowedPaths,
        });
        return;
      }
    }
    for (const parentSha of commit.parents) {
      const parent = await getCommitInfo(octokit, owner, repo, parentSha);
      if (parent.treeSha === alphaTreeSha) {
        try {
          await assertChannelPromotionPr({
            octokit,
            owner,
            repo,
            sha: parentSha,
            targetRef,
          });
        } catch (error) {
          const matchingReleaseRecoveryPullRequest =
            await findMatchingReleaseRecoveryPullRequest({ commitSha: parentSha, targetRef });
          if (!matchingReleaseRecoveryPullRequest) {
            throw error;
          }
          await assertOnlyAllowedReleaseRecoveryChangesBetween({
            baseSha: alphaSha,
            headSha: parentSha,
            allowedPaths,
          });
        }
        await assertOnlyAllowedChangesBetween({
          baseSha: parentSha,
          headSha: commitSha,
          allowedPaths,
        });
        return;
      }
      const matchingReleaseRecoveryPullRequest =
        await findMatchingReleaseRecoveryPullRequest({ commitSha: parentSha, targetRef });
      if (matchingReleaseRecoveryPullRequest) {
        await assertOnlyAllowedReleaseRecoveryChangesBetween({
          baseSha: alphaSha,
          headSha: parentSha,
          allowedPaths,
        });
        await assertOnlyAllowedChangesBetween({
          baseSha: parentSha,
          headSha: commitSha,
          allowedPaths,
        });
        return;
      }
    }
    const matchingReleaseRecoveryPullRequest =
      await findMatchingReleaseRecoveryPullRequest({ commitSha, targetRef });
    if (matchingReleaseRecoveryPullRequest) {
      await assertOnlyAllowedReleaseRecoveryChangesBetween({
        baseSha: alphaSha,
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
    const configuredVersion = manualNext
      ? currentConfiguredVersion(discovered.files)
      : undefined;
    const publishVersion = manualNext ? configuredVersion || version : version;
    const hasVersionVerification =
      Boolean(verificationCommand || getLifecycleStage(discovered.config, "verify"));
    const anchoredReleaseTreePaths =
      manualNext && anchorManifest && hasVersionVerification
        ? uniquePaths([...discoveredPaths, anchorManifest.path])
        : discoveredPaths;
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
        publishVersion,
      });
      return {
        sha: baseSha,
        version,
        action: "anchored-manual",
        publishVersion,
        files: discoveredPaths,
        releaseTreeAllowedPaths: anchoredReleaseTreePaths,
        hasVersionVerification,
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
        publishVersion,
      });
      return {
        sha: baseSha,
        version,
        action: "existing",
        publishVersion,
        files: discoveredPaths,
        releaseTreeAllowedPaths: discoveredPaths,
        hasVersionVerification,
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
        publishVersion,
        files: changedFiles.map((file) => file.path),
        releaseTreeAllowedPaths: changedFiles.map((file) => file.path),
        hasVersionVerification,
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
      publishVersion,
      files: changedFiles.map((file) => file.path),
      releaseTreeAllowedPaths: changedFiles.map((file) => file.path),
      hasVersionVerification,
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
    const transactionVersion = version;
    if (dryRun && (publishTransaction || publishCommand || getLifecycleStage(loadBuildchainConfig(cwd), "publish"))) {
      updates.push({
        action: "dry-run-publish-transaction",
        version: transactionVersion,
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
      version: transactionVersion,
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
      publishMode,
      publishAuth,
      publishDistTag,
      publishPackageSetOrder,
      publishPackageMain,
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
      version: releaseCommit.publishVersion || releaseVersion,
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
    const currentAlphaTransaction = currentAlpha
      ? await readDurableTransactionForVersion({
          octokit,
          owner,
          repo,
          version: currentAlpha.version,
        })
      : undefined;
    const publishTransactionEnabled = Boolean(
      publishTransaction ||
      publishCommand ||
      getLifecycleStage(loadBuildchainConfig(cwd), "publish")
    );
    const resumableAlpha = explicitAlphaTags[0] || !publishTransactionEnabled
      ? undefined
      : await resumableAlphaTransactionState({
          octokit,
          owner,
          repo,
          cwd,
          refs: lineRefs,
          releasePrefix: rule.releasePrefix,
          targetRef,
          sourceSha: sha,
        });
    const currentAlphaTagSha = currentAlpha
      ? await readRefSha(`tags/${currentAlpha.tag}`)
      : undefined;
    const currentAlphaFloatingSha = currentAlpha
      ? await readRefSha(`tags/${rule.alphaTag}`)
      : undefined;
    const currentAlphaDevSha = currentAlpha
      ? await readRefSha(`heads/dev/v${rule.major}/v${rule.major}.${rule.minor}`)
      : undefined;
    const currentAlphaAcceptedExactShas = transactionAcceptedExactTagShas(
      currentAlphaTransaction,
      sha,
    );
    const currentAlphaSettled =
      currentAlpha &&
      currentAlphaDevSha === sha &&
      currentAlphaFloatingSha === sha &&
      currentAlphaTagSha &&
      currentAlphaAcceptedExactShas.includes(currentAlphaTagSha);
    const currentAlphaHasFinalizationRefs =
      currentAlpha && Boolean(currentAlphaTagSha || currentAlphaFloatingSha || currentAlphaDevSha);
    const currentAlphaTransactionOpen =
      currentAlphaTransaction &&
      !["complete", "abandoned", "failed_permanently"].includes(currentAlphaTransaction.state);
    const currentAlphaContainsTransaction =
      currentAlphaTransactionOpen &&
      (
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sha,
          transactionReleaseSha: currentAlphaTransaction.release_sha,
        }) ||
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sha,
          transactionReleaseSha: currentAlphaTransaction.release_material_sha,
        })
      );
    let selectedAlpha = explicitAlphaTags[0]
      ? { tag: explicitAlphaTags[0] }
      : currentAlphaTransactionOpen && (currentAlphaHasFinalizationRefs || currentAlphaContainsTransaction) && !currentAlphaSettled
        ? currentAlpha
      : currentAlpha && currentAlphaHasFinalizationRefs && !currentAlphaTagSha
        ? currentAlpha
      : resumableAlpha
        ? resumableAlpha
      : currentAlphaTransactionOpen && currentAlpha && !currentAlphaTagSha
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
      if (candidate.transaction?.release_sha) {
        return {
          version,
          publishVersion: version,
          commit: { action: "existing-publish-transaction", files: [] },
          sha: candidate.transaction.release_sha,
        };
      }
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
      return { version, publishVersion: commit.publishVersion || version, commit, sha: commit.sha };
    };
    let alpha = await prepareAlphaCommit(selectedAlpha);
    try {
      await executePublishTransaction({
        version: alpha.publishVersion || alpha.version,
        exactTag: selectedAlpha.tag,
        channel: rule.channel,
        line: rule.releasePrefix,
        releaseSha: alpha.sha,
        allowVersionStateFinalization:
          currentAlpha &&
          selectedAlpha.tag === currentAlpha.tag &&
          alpha.commit.action === "existing",
      });
    } catch (error) {
      const staleCurrentAlpha =
          currentAlpha &&
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
        version: alpha.publishVersion || alpha.version,
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
    await ensureTag(selectedAlpha.tag, alpha.sha, {
      acceptedExistingShas: transactionAcceptedExactTagShas(
        latestPublishTransaction?.transaction || currentAlphaTransaction,
        alpha.sha,
      ),
      acceptedExistingMaterialShas: transactionAcceptedExactTagShas(
        latestPublishTransaction?.transaction || currentAlphaTransaction,
        "",
      ),
    });
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
    : undefined;
  const currentRelease = selectedRelease
    ? undefined
    : currentReleaseVersionState({
        cwd,
        refs: lineRefs,
        releasePrefix: rule.releasePrefix,
      });
  const currentReleaseTransaction = currentRelease
    ? await readDurableTransactionForVersion({
        octokit,
        owner,
        repo,
        version: currentRelease.version,
      })
    : undefined;
  const currentReleaseExactSha = currentRelease
    ? await readRefSha(`tags/${currentRelease.tag}`)
    : undefined;
  const currentReleaseMinorSha = currentRelease
    ? await readRefSha(`tags/${rule.minorTag}`)
    : undefined;
  const currentReleaseMajorSha = currentRelease
    ? await readRefSha(`tags/${rule.majorTag}`)
    : undefined;
  const currentReleaseAcceptedExactShas = transactionAcceptedExactTagShas(
    currentReleaseTransaction,
    sha,
  );
  const currentReleaseSettled =
    currentRelease &&
    currentReleaseMinorSha === sha &&
    currentReleaseMajorSha === sha &&
    currentReleaseExactSha &&
    currentReleaseAcceptedExactShas.includes(currentReleaseExactSha);
  const selectedReleaseCandidate = selectedRelease ||
    (currentRelease && !currentReleaseSettled
      ? currentRelease
      : selectReleaseTag({
          refs: lineRefs,
          releasePrefix: rule.releasePrefix,
          sha,
        }));
  const sourceAlpha = latestAlphaForPatch(
    lineRefs,
    rule.releasePrefix,
    selectedReleaseCandidate.patch,
  );
  let sourceAlphaMaterial = sourceAlpha;
  const floatingAlphaSha = sourceAlpha?.sha
    ? await readRefSha(`tags/${rule.alphaTag}`)
    : undefined;
  if (sourceAlpha?.sha && floatingAlphaSha && floatingAlphaSha !== sourceAlpha.sha) {
    const floatingContainsExact = await releaseCommitIncludesTransactionHead({
      octokit,
      owner,
      repo,
      releaseSha: floatingAlphaSha,
      transactionReleaseSha: sourceAlpha.sha,
    });
    const targetContainsFloating = await releaseCommitIncludesTransactionHead({
      octokit,
      owner,
      repo,
      releaseSha: sha,
      transactionReleaseSha: floatingAlphaSha,
    });
    if (floatingContainsExact && targetContainsFloating) {
      sourceAlphaMaterial = {
        ...sourceAlpha,
        tag: rule.alphaTag,
        exactTag: sourceAlpha.tag,
        sha: floatingAlphaSha,
      };
    }
  }
  const releaseVersion = stripTagPrefix(selectedReleaseCandidate.tag);
  const releaseCommit = await createVersionStateCommit({
    baseSha: sha,
    version: releaseVersion,
    message: `chore(release): release ${selectedReleaseCandidate.tag}`,
  });
  const releaseSha = releaseCommit.sha;
  if (requireGovernance && !dryRun) {
    if (!sourceAlpha?.sha) {
      throw new Error(
        `Release promotion requires an existing ${rule.releasePrefix}.${selectedReleaseCandidate.patch}-alpha.N tag`,
      );
    }
    const alphaCommit = await getCommitInfo(octokit, owner, repo, sourceAlphaMaterial.sha);
    const releaseTreeAllowedPaths =
      releaseCommit.releaseTreeAllowedPaths || releaseCommit.files;
    await assertReleasePrOrVersionStateParent({
      commitSha: releaseSha,
      targetRef,
      alphaSha: sourceAlphaMaterial.sha,
      alphaTag: sourceAlphaMaterial.tag,
      alphaTreeSha: alphaCommit.treeSha,
      allowedPaths: releaseTreeAllowedPaths,
      allowDirectAllowedChanges:
        releaseCommit.action === "anchored-manual" &&
        releaseCommit.versionStrategy?.strategy === "anchored" &&
        releaseCommit.versionStrategy?.next === "manual" &&
        releaseCommit.files.length > 0 &&
        Boolean(releaseCommit.anchorManifest) &&
        releaseCommit.hasVersionVerification,
    });
  }
  await executePublishTransaction({
    version: releaseCommit.publishVersion || releaseVersion,
    exactTag: selectedReleaseCandidate.tag,
    channel: rule.channel,
    line: rule.releasePrefix,
    releaseSha,
    allowVersionStateFinalization: releaseCommit.action === "existing",
  });
  if (versionState) {
    await markFinalizing();
    const targetUpdate = await updateBranch(targetRef, releaseSha, "updated", {
      title: `Release ${selectedReleaseCandidate.tag}`,
      body: `Create the generated version-state commit for ${selectedReleaseCandidate.tag}.`,
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
  await ensureTag(selectedReleaseCandidate.tag, releaseSha, {
    acceptedExistingShas: transactionAcceptedExactTagShas(
      latestPublishTransaction?.transaction || currentReleaseTransaction,
      releaseSha,
    ),
    acceptedExistingMaterialShas: transactionAcceptedExactTagShas(
      latestPublishTransaction?.transaction || currentReleaseTransaction,
      "",
    ),
  });
  await updateTag(rule.minorTag, releaseSha);
  const ownsMajorFloatingTag = await shouldPromoteMajorTag();
  if (ownsMajorFloatingTag) {
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
    if (ownsMajorFloatingTag) {
      await updateDefaultBranch(`dev/v${rule.major}/v${rule.major}.${rule.minor}`);
    }
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
        patchAfterRelease: selectedReleaseCandidate.patch + 1,
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
    const nextDevRef = `dev/v${rule.major}/v${rule.major}.${rule.minor}`;
    await updateBranch(nextDevRef, nextAlphaSha);
    if (ownsMajorFloatingTag) {
      await updateDefaultBranch(nextDevRef);
    }
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
  readDurableReleaseTransaction,
  restoreDurableReleaseTransaction,
  resolveTagsForTarget,
  selectAlphaTag,
  selectReleaseTag,
  stripTagPrefix,
  updateVersionStateContents,
};
