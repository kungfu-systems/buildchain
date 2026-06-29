const DEFAULT_REPOSITORY = "kungfu-systems/buildchain";
const CHANNEL_RULES = {
  alpha: {
    refPattern: /^alpha\/v1\/v1\.0$/,
    tags: ["v1-alpha"],
  },
  release: {
    refPattern: /^release\/v1\/v1\.0$/,
    tags: ["v1", "v1.0"],
  },
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
    if (!/^v\d+(?:\.\d+)?(?:-alpha)?$/.test(tag)) {
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
  const channel = String(targetRef || "").split("/", 1)[0];
  const rule = CHANNEL_RULES[channel];
  if (!rule || !rule.refPattern.test(targetRef)) {
    throw new Error(`Ref promotion target must be alpha/v1/v1.0 or release/v1/v1.0; got ${targetRef}`);
  }
  return { channel, tags: rule.tags };
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
    if (!rule.tags.includes(tag)) {
      throw new Error(`Tag ${tag} is not allowed for ${rule.channel} promotion`);
    }
  }
  return tags;
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
  const promotionTags = resolveTagsForTarget(targetRef, tags);

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
  for (const tag of promotionTags) {
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
  CHANNEL_RULES,
  assertPromotableRepository,
  assertPromotableTargetRef,
  assertSha,
  getPromotionRule,
  parseRepository,
  parseTags,
  promoteBuildchainRefs,
  resolveTagsForTarget,
};
