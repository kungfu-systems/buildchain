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
    await ensureTag(selectedAlpha.tag);
    await updateTag(rule.alphaTag);
    return { owner, repo, sha, targetRef, updates };
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
  await ensureTag(selectedRelease.tag);
  await updateTag(rule.minorTag);
  if (await shouldPromoteMajorTag()) {
    await updateTag(rule.majorTag);
  } else {
    updates.push({
      tag: rule.majorTag,
      action: "skipped-next-minor-exists",
      sha,
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
        sha,
        patchAfterRelease: selectedRelease.patch + 1,
      });
  await ensureTag(selectedNextAlpha.tag);
  await updateTag(rule.alphaTag);
  return { owner, repo, sha, targetRef, updates };
}

module.exports = {
  DEFAULT_REPOSITORY,
  assertPromotableRepository,
  assertPromotableTargetRef,
  assertSha,
  getPromotionRule,
  parseAlphaPrereleaseTag,
  parseRepository,
  parseReleasePatchTag,
  parseTags,
  promoteBuildchainRefs,
  resolveTagsForTarget,
  selectAlphaTag,
  selectReleaseTag,
};
