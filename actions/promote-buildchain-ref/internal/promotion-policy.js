const DEFAULT_REPOSITORY = "kungfu-systems/buildchain";
const MAJOR_GATE_REF = "publish-gate/major";
const LEGACY_MAJOR_GATE_REF = "major-gate";
const RELEASE_LINE_RECOVERY_PATHS = [
  ".github/workflows/buildchain-ref-promotion.yml", "actions/promote-buildchain-ref/",
  "packages/core/self-dogfood-version.js",
  "scripts/check-inventory.mjs",
  "scripts/release-line-policy.mjs",
  "tests/build-surface.test.mjs",
  "tests/promote-buildchain-ref.test.mjs",
  "tests/release-line-policy.test.mjs",
];

function isAllowedReleaseLineRecoveryPath(file, allowedPaths = []) {
  if (allowedPaths.includes(file)) {
    return true;
  }
  return RELEASE_LINE_RECOVERY_PATHS.some((allowedPath) =>
    allowedPath.endsWith("/") ? file.startsWith(allowedPath) : file === allowedPath,
  );
}

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
      !/^v\d+$|^v\d+-alpha$|^v\d+\.\d+$|^v\d+\.\d+-alpha$|^v\d+\.\d+\.\d+$|^v\d+\.\d+\.\d+-alpha\.\d+$/.test(
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
  const majorAlphaTag = `${majorTag}-alpha`;
  const minorTag = releasePrefix;
  const alphaTag = `${releasePrefix}-alpha`;
  if (channel === "alpha") {
    return {
      channel,
      major,
      minor,
      releasePrefix,
      majorTag,
      majorAlphaTag,
      minorTag,
      alphaTag,
      tags: [alphaTag, majorAlphaTag],
    };
  }
  return {
    channel,
    major,
    minor,
    releasePrefix,
    majorTag,
    majorAlphaTag,
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

function expectedHeadRefForTarget(targetRef) {
  const rule = getPromotionRule(targetRef);
  if (rule.channel === "major") {
    return "release/vN/vN.M";
  }
  return rule.channel === "alpha"
    ? `dev/v${rule.major}/v${rule.major}.${rule.minor}`
    : `alpha/v${rule.major}/v${rule.major}.${rule.minor}`;
}

function parsePublishGateChannelRef(ref) {
  const match = String(ref || "").match(
    /^publish-gate\/(alpha|release)\/v(\d+)\/v(\d+)\.(\d+)\/([^/]+)$/,
  );
  if (!match) {
    return undefined;
  }
  const channel = match[1];
  const major = Number(match[2]);
  const minorMajor = Number(match[3]);
  const minor = Number(match[4]);
  if (major !== minorMajor) {
    throw new Error(`Publish-gate ref major mismatch: ${ref}`);
  }
  return {
    ref,
    channel,
    major,
    minor,
    targetRef: `${channel}/v${major}/v${major}.${minor}`,
    consumerVersion: match[5],
  };
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
  const match = String(ref || "").match(
    /^fix\/release-line-v(\d+)-v(\d+)\.(\d+)-[0-9A-Za-z._-]+$/,
  );
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

export {
  DEFAULT_REPOSITORY,
  LEGACY_MAJOR_GATE_REF,
  MAJOR_GATE_REF,
  RELEASE_LINE_RECOVERY_PATHS,
  assertPromotableRepository,
  assertPromotableTargetRef,
  assertSha,
  expectedHeadRefForTarget,
  getPromotionRule,
  isAllowedReleaseLineRecoveryPath,
  parsePublishGateChannelRef,
  parseReleaseLineRecoveryRef,
  parseReleaseLineRef,
  parseRepository,
  parseTags,
  stripTagPrefix,
};
