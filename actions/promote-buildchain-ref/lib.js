const DEFAULT_REPOSITORY = "kungfu-systems/buildchain";
function parseTags(input) {
  const tags = String(input || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.length === 0) {
    throw new Error("At least one tag must be provided");
  }
  for (const tag of tags) {
    if (!/^(?:v\d+(?:\.\d+)?(?:-alpha)?|\d+\.\d+\.\d+)$/.test(tag)) {
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

function assertPromotableRepository(owner, repo, allowRepository = DEFAULT_REPOSITORY) {
  const allowed = parseRepository(allowRepository);
  if (owner !== allowed.owner || repo !== allowed.repo) {
    throw new Error(`Ref promotion is limited to ${allowRepository}; got ${owner}/${repo}`);
  }
}

function getPromotionRule(targetRef) {
  const match = String(targetRef || "").match(/^(alpha|release)\/v(\d+)\/v(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Ref promotion target must be alpha/vN/vN.M or release/vN/vN.M; got ${targetRef}`);
  }
  const channel = match[1];
  const major = Number(match[2]);
  const minorMajor = Number(match[3]);
  const minor = Number(match[4]);
  if (major !== minorMajor) {
    throw new Error(`Ref promotion target major mismatch: ${targetRef}`);
  }
  const majorTag = `v${major}`;
  const minorTag = `v${major}.${minor}`;
  if (channel === "alpha") {
    return { channel, major, minor, releasePrefix: `${major}.${minor}`, tags: [`${majorTag}-alpha`] };
  }
  return { channel, major, minor, releasePrefix: `${major}.${minor}`, tags: [majorTag, minorTag] };
}

function assertPromotableTargetRef(targetRef) {
  getPromotionRule(targetRef);
}

function assertSha(sha) {
  if (!/^[0-9a-f]{40}$/i.test(String(sha || ""))) {
    throw new Error(`Invalid commit SHA: ${sha}`);
  }
}

function resolveTagsForTarget(targetRef, inputTags) {
  const rule = getPromotionRule(targetRef);
  const tags = inputTags && inputTags.length > 0 ? inputTags : rule.tags;
  for (const tag of tags) {
    const isReleasePatchTag = rule.channel === "release" && tag.startsWith(`${rule.releasePrefix}.`);
    if (!rule.tags.includes(tag) && !isReleasePatchTag) {
      throw new Error(`Tag ${tag} is not allowed for ${rule.channel} promotion`);
    }
  }
  return tags;
}

function parseReleasePatchTag(refName, releasePrefix) {
  const match = String(refName || "").match(new RegExp(`^refs/tags/${releasePrefix.replace(".", "\\.")}\\.(\\d+)$`));
  if (!match) {
    return undefined;
  }
  return {
    tag: refName.replace(/^refs\/tags\//, ""),
    patch: Number(match[1]),
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
    return { tag: existingForSha.tag, exists: true };
  }
  const latestPatch = releaseTags.length > 0 ? releaseTags[releaseTags.length - 1].patch : -1;
  return { tag: `${releasePrefix}.${latestPatch + 1}`, exists: false };
}

function notFound(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return status === 404 || (status === 422 && /Reference does not exist/i.test(message));
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
}) {
  assertPromotableRepository(owner, repo, allowRepository);
  assertPromotableTargetRef(targetRef);
  assertSha(sha);
  const rule = getPromotionRule(targetRef);
  const requestedTags = tags ? resolveTagsForTarget(targetRef, tags) : undefined;
  const requestedCompatibilityTags = requestedTags
    ? requestedTags.filter((tag) => !/^\d+\.\d+\.\d+$/.test(tag))
    : undefined;
  const compatibilityTags =
    requestedCompatibilityTags && requestedCompatibilityTags.length > 0 ? requestedCompatibilityTags : rule.tags;

  const { data: branchRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${targetRef}`,
  });
  const branchSha = branchRef.object.sha;
  if (branchSha !== sha) {
    throw new Error(`Ref ${targetRef} points at ${branchSha}, not requested SHA ${sha}`);
  }

  const updates = [];
  if (rule.channel === "release") {
    const explicitReleaseTags = requestedTags ? requestedTags.filter((tag) => /^\d+\.\d+\.\d+$/.test(tag)) : [];
    if (explicitReleaseTags.length > 1) {
      throw new Error("Release promotion accepts at most one explicit patch tag");
    }
    let releaseTag = explicitReleaseTags[0];
    let releaseTagExists = false;
    if (!releaseTag) {
      const { data: refs } = await octokit.rest.git.listMatchingRefs({
        owner,
        repo,
        ref: `tags/${rule.releasePrefix}.`,
      });
      const selected = selectReleaseTag({ refs, releasePrefix: rule.releasePrefix, sha });
      releaseTag = selected.tag;
      releaseTagExists = selected.exists;
    }
    if (dryRun) {
      updates.push({ tag: releaseTag, action: "dry-run", sha });
    } else {
      try {
        const { data: tagRef } = await octokit.rest.git.getRef({
          owner,
          repo,
          ref: `tags/${releaseTag}`,
        });
        if (tagRef.object.sha !== sha) {
          throw new Error(`Release tag ${releaseTag} points at ${tagRef.object.sha}, not requested SHA ${sha}`);
        }
        updates.push({ tag: releaseTag, action: "existing", sha });
      } catch (error) {
        if (!notFound(error)) {
          throw error;
        }
        if (releaseTagExists) {
          throw error;
        }
        await octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/tags/${releaseTag}`,
          sha,
        });
        updates.push({ tag: releaseTag, action: "created", sha });
      }
    }
  }

  for (const tag of compatibilityTags) {
    const ref = `tags/${tag}`;
    if (dryRun) {
      updates.push({ tag, action: "dry-run", sha });
      continue;
    }
    try {
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref,
        sha,
        force: true,
      });
      updates.push({ tag, action: "updated", sha });
    } catch (error) {
      if (!notFound(error)) {
        throw error;
      }
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/${ref}`,
        sha,
      });
      updates.push({ tag, action: "created", sha });
    }
  }
  return { owner, repo, sha, targetRef, updates };
}

module.exports = {
  DEFAULT_REPOSITORY,
  assertPromotableRepository,
  assertPromotableTargetRef,
  assertSha,
  getPromotionRule,
  parseRepository,
  parseReleasePatchTag,
  parseTags,
  promoteBuildchainRefs,
  resolveTagsForTarget,
  selectReleaseTag,
};
