const DEFAULT_REPOSITORY = "kungfu-systems/buildchain";
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const {
  detectPackageManager,
  getWorkspaceInfo,
} = require("../../packages/core/package-manager.cjs");
const {
  discoverConfiguredVersionStateFiles,
  getVersionStrategy,
  getLifecycleStage,
  loadConfiguredAnchorManifest,
  loadBuildchainConfig,
  runLifecycleStage,
  updateConfiguredVersionStateContents,
} = require("../../packages/core/buildchain-config.cjs");

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
      const parsed = parseAlphaPrereleaseTag(ref.ref, releasePrefix);
      if (!parsed) {
        return undefined;
      }
      return { ...parsed, sha: ref.object?.sha };
    })
    .filter(Boolean)
    .sort((a, b) => a.patch - b.patch || a.prerelease - b.prerelease);

  if (patchAfterRelease !== undefined) {
    const samePatchTags = alphaTags.filter(
      (tag) => tag.patch === patchAfterRelease,
    );
    const existingForSha = samePatchTags.find((tag) => tag.sha === sha);
    if (existingForSha) {
      return {
        tag: existingForSha.tag,
        patch: existingForSha.patch,
        prerelease: existingForSha.prerelease,
        sha: existingForSha.sha,
        exists: true,
      };
    }
    if (samePatchTags.length > 0) {
      const prepared = samePatchTags[0];
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

  const existingForSha = alphaTags.find((tag) => tag.sha === sha);
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

function protectedBranchUpdateRejected(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return (
    status === 422 &&
    /Changes must be made through a pull request|Required status check/i.test(message)
  );
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

  const listLineRefs = async () => {
    const { data: refs } = await octokit.rest.git.listMatchingRefs({
      owner,
      repo,
      ref: `tags/${rule.releasePrefix}.`,
    });
    return refs;
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
    const { data: refs } = await octokit.rest.git.listMatchingRefs({
      owner,
      repo,
      ref: `tags/${majorRule.releasePrefix}.`,
    });
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
    if (versionState) {
      const gateUpdate = await updateBranch(targetRef, releaseSha, "updated", {
        title: `Release ${selectedRelease.tag}`,
        body: `Create the generated version-state commit for ${selectedRelease.tag}.`,
      });
      if (gateUpdate.pending) {
        return {
          owner,
          repo,
          sourceSha: sha,
          sha: releaseSha,
          targetRef,
          pendingPullRequest: gateUpdate.pullRequest.html_url || gateUpdate.pullRequest.url,
          updates,
        };
      }
      await updateBranch(`release/v${majorRule.major}/v${majorRule.major}.0`, releaseSha);
    }
    await ensureTag(selectedRelease.tag, releaseSha);
    await updateTag(majorRule.minorTag, releaseSha);
    await updateTag(majorRule.majorTag, releaseSha);

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
    return {
      owner,
      repo,
      sourceSha: sha,
      sha: releaseSha,
      nextAlphaSha,
      targetRef,
      updates,
    };
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
    const selectedAlpha = explicitAlphaTags[0]
      ? { tag: explicitAlphaTags[0] }
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
    const alphaVersion = stripTagPrefix(selectedAlpha.tag);
    const alphaCommit = await createVersionStateCommit({
      baseSha: sha,
      version: alphaVersion,
      message: `chore(release): prepare ${selectedAlpha.tag}`,
    });
    const alphaSha = alphaCommit.sha;
    if (requireGovernance && !dryRun) {
      if (alphaCommit.action === "existing") {
        await assertPromotionPrOrVersionStateParent({
          commitSha: sha,
          targetRef,
          allowedPaths: alphaCommit.files,
        });
      } else {
        await assertChannelPromotionPr({
          octokit,
          owner,
          repo,
          sha,
          targetRef,
        });
      }
    }
    if (versionState) {
      const targetUpdate = await updateBranch(targetRef, alphaSha, "updated", {
        title: `Prepare ${selectedAlpha.tag}`,
        body: `Create the generated version-state commit for ${selectedAlpha.tag}.`,
      });
      if (targetUpdate.pending) {
        return {
          owner,
          repo,
          sourceSha: sha,
          sha: alphaSha,
          targetRef,
          pendingPullRequest: targetUpdate.pullRequest.html_url || targetUpdate.pullRequest.url,
          updates,
        };
      }
      await updateBranch(`dev/v${rule.major}/v${rule.major}.${rule.minor}`, alphaSha);
    }
    await ensureTag(selectedAlpha.tag, alphaSha);
    await updateTag(rule.alphaTag, alphaSha);
    return { owner, repo, sourceSha: sha, sha: alphaSha, targetRef, updates };
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
  if (versionState) {
    const targetUpdate = await updateBranch(targetRef, releaseSha, "updated", {
      title: `Release ${selectedRelease.tag}`,
      body: `Create the generated version-state commit for ${selectedRelease.tag}.`,
    });
    if (targetUpdate.pending) {
      return {
        owner,
        repo,
        sourceSha: sha,
        sha: releaseSha,
        targetRef,
        pendingPullRequest: targetUpdate.pullRequest.html_url || targetUpdate.pullRequest.url,
        updates,
      };
    }
  }
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

  if (releaseCommit.versionStrategy?.next === "manual") {
    updates.push({
      ref: `dev/v${rule.major}/v${rule.major}.${rule.minor}`,
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
    };
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
      return {
        owner,
        repo,
        sourceSha: sha,
        sha: releaseSha,
        nextAlphaSha,
        targetRef,
        pendingPullRequest:
          nextAlphaUpdate.pullRequest.html_url || nextAlphaUpdate.pullRequest.url,
        updates,
      };
    }
    await updateBranch(`dev/v${rule.major}/v${rule.major}.${rule.minor}`, nextAlphaSha);
  }
  await ensureTag(selectedNextAlpha.tag, nextAlphaSha);
  await updateTag(rule.alphaTag, nextAlphaSha);
  return {
    owner,
    repo,
    sourceSha: sha,
    sha: releaseSha,
    nextAlphaSha,
    targetRef,
    updates,
  };
}

module.exports = {
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
  resolveTagsForTarget,
  selectAlphaTag,
  selectReleaseTag,
  stripTagPrefix,
  updateVersionStateContents,
};
