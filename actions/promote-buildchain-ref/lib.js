const DEFAULT_REPOSITORY = "kungfu-systems/buildchain";
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const {
  detectPackageManager,
  getWorkspaceInfo,
} = require("../../packages/core/package-manager.cjs");

const COMMIT_IDENTITY = {
  name: "Keren Dong",
  email: "keren.dong@kungfu.link",
};

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
  const match = String(targetRef || "").match(
    /^(alpha|release)\/v(\d+)\/v(\d+)\.(\d+)$/,
  );
  if (!match) {
    throw new Error(
      `Ref promotion target must be alpha/vN/vN.M or release/vN/vN.M; got ${targetRef}`,
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
  };
}

function updateVersionStateContents(files, version) {
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
  return rule.channel === "alpha"
    ? `dev/v${rule.major}/v${rule.major}.${rule.minor}`
    : `alpha/v${rule.major}/v${rule.major}.${rule.minor}`;
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

function runVersionVerification({ cwd, command, changedFiles, allowedPaths }) {
  if (!command) {
    return;
  }
  applyLocalVersionState(cwd, changedFiles);
  execSync(command, { cwd, stdio: "inherit", shell: true });
  assertAllowedLocalChanges(cwd, allowedPaths);
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
    if (error.status !== 403) {
      throw error;
    }
    const { data: branch } = await octokit.rest.repos.getBranch({
      owner,
      repo,
      branch: targetRef,
    });
    if (!branch.protected) {
      throw new Error(`Promotion target ${targetRef} must be a protected branch`);
    }
    console.log(
      `> branch protection details for ${targetRef} are not readable by this token; ` +
        "using protected branch status plus merged PR governance checks",
    );
    return;
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

  const updateBranch = async (branch, branchSha, action = "updated") => {
    if (dryRun) {
      updates.push({ ref: branch, action: "dry-run", sha: branchSha });
      return;
    }
    try {
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: branchSha,
        force: false,
      });
      updates.push({ ref: branch, action, sha: branchSha });
    } catch (error) {
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

    const changedFiles = updateVersionStateContents(discovered.files, version);
    const discoveredPaths = discovered.files.map((file) => file.path);
    const changedPaths = changedFiles.map((file) => file.path);
    console.log(
      `> version state manager: ${discovered.packageManager.name} (${discovered.packageManager.reason})`,
    );
    console.log(`> version state files: ${discoveredPaths.join(", ")}`);
    console.log(
      `> version state changes for ${version}: ${changedPaths.length ? changedPaths.join(", ") : "none"}`,
    );
    if (changedFiles.length === 0) {
      runVersionVerification({
        cwd,
        command: verificationCommand,
        changedFiles: [],
        allowedPaths: discoveredPaths,
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
      };
    }

    runVersionVerification({
      cwd,
      command: verificationCommand,
      changedFiles,
      allowedPaths: discoveredPaths,
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

  const lineRefs = await listLineRefs();

  if (requireGovernance && !dryRun) {
    await assertProtectedChannel({
      octokit,
      owner,
      repo,
      targetRef,
      requiredStatusCheck,
    });
  }

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
    if (requireGovernance && !dryRun && !settledAlphaVersionState) {
      await assertChannelPromotionPr({
        octokit,
        owner,
        repo,
        sha,
        targetRef,
      });
    }
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
    if (versionState) {
      await updateBranch(targetRef, alphaSha);
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
  if (requireGovernance && !dryRun) {
    if (!sourceAlpha?.sha) {
      throw new Error(
        `Release promotion requires an existing ${rule.releasePrefix}.${selectedRelease.patch}-alpha.N tag`,
      );
    }
    const releaseCandidateCommit = await getCommitInfo(octokit, owner, repo, sha);
    const alphaCommit = await getCommitInfo(octokit, owner, repo, sourceAlpha.sha);
    const prSourceSha =
      selectedRelease.exists && releaseCandidateCommit.parents.length > 0
        ? releaseCandidateCommit.parents[0]
        : sha;
    const prSourceCommit =
      prSourceSha === sha
        ? releaseCandidateCommit
        : await getCommitInfo(octokit, owner, repo, prSourceSha);
    if (prSourceCommit.treeSha !== alphaCommit.treeSha) {
      throw new Error(
        `Release source ${prSourceSha} must have the same tree as ${sourceAlpha.tag} (${sourceAlpha.sha})`,
      );
    }
    await assertChannelPromotionPr({
      octokit,
      owner,
      repo,
      sha: prSourceSha,
      targetRef,
    });
  }
  const releaseVersion = stripTagPrefix(selectedRelease.tag);
  const releaseCommit = await createVersionStateCommit({
    baseSha: sha,
    version: releaseVersion,
    message: `chore(release): release ${selectedRelease.tag}`,
  });
  const releaseSha = releaseCommit.sha;
  if (versionState) {
    await updateBranch(targetRef, releaseSha);
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
    await updateBranch(`alpha/v${rule.major}/v${rule.major}.${rule.minor}`, nextAlphaSha);
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
