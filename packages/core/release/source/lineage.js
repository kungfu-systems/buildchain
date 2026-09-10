import { assertSha } from "./coordinates.js";
import { normalizeGitRefName } from "./coordinates.js";
import { parsePublishSourceRef } from "./coordinates.js";
import { resolvePublishChannelTargetRef } from "./coordinates.js";
export function expectedPublishChannelHeadRef(targetRef) {
  const ref = normalizeGitRefName(targetRef);
  if (ref === "publish-gate/major") {
    return "release/vN/vN.M";
  }
  const match = ref.match(/^(alpha|release)\/v(\d+)\/v(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(
      `publish target channel ref must be alpha/vN/vN.M, release/vN/vN.M, or publish-gate/major; got ${ref || "<empty>"}`,
    );
  }
  const [, channel, major, lineMajor, minor] = match;
  if (major !== lineMajor) {
    throw new Error(`publish target channel ref major mismatch: ${ref}`);
  }
  return channel === "alpha"
    ? `dev/v${major}/v${major}.${minor}`
    : `alpha/v${major}/v${major}.${minor}`;
}

export function isReleaseLineRef(ref = "") {
  const match = String(ref || "").match(/^release\/v(\d+)\/v(\d+)\.(\d+)$/);
  return !!match && match[1] === match[2];
}

export function verifyPublishChannelPrLineage({
  sourceRef = "",
  sourceSha = "",
  targetRef = "",
  repository = "",
  pullRequests = [],
} = {}) {
  const parsed = parsePublishSourceRef(sourceRef);
  const resolvedTargetRef = resolvePublishChannelTargetRef({
    sourceRef,
    targetRef,
  });
  if (!parsed.enabled || parsed.anchor || !resolvedTargetRef) {
    return {
      ok: true,
      skipped: true,
      sourceRef: parsed.sourceRef || normalizeGitRefName(sourceRef),
      targetRef: resolvedTargetRef,
      reason: !parsed.enabled
        ? "publish source ref is not configured"
        : parsed.anchor
          ? "publish-gate/anchor has no channel target ref"
          : "publish target channel ref is not configured",
    };
  }
  const sha = assertSha(sourceSha, "sourceSha");
  const expectedHeadRef = expectedPublishChannelHeadRef(resolvedTargetRef);
  const expectedRepository = String(repository || "").trim();
  if (!expectedRepository) {
    throw new Error(
      "repository is required to verify publish channel PR lineage",
    );
  }
  const matchingPullRequest = (pullRequests || []).find((pullRequest) => {
    const baseRef = pullRequest?.base?.ref || "";
    const headRef = pullRequest?.head?.ref || "";
    const headRepo = pullRequest?.head?.repo?.full_name || "";
    if (
      !pullRequest?.merged_at ||
      baseRef !== resolvedTargetRef ||
      headRepo !== expectedRepository
    ) {
      return false;
    }
    if (resolvedTargetRef === "publish-gate/major") {
      return isReleaseLineRef(headRef);
    }
    return headRef === expectedHeadRef;
  });
  if (!matchingPullRequest) {
    throw new Error(
      `publish source-lock PR lineage mismatch: ${parsed.sourceRef} is locked at ${sha}, but target channel ref ${resolvedTargetRef} must come from a merged same-repository PR ${expectedHeadRef} -> ${resolvedTargetRef}. Merge the source commit through that channel PR before running publish verification.`,
    );
  }
  return {
    ok: true,
    skipped: false,
    sourceRef: parsed.sourceRef,
    sourceSha: sha,
    targetRef: resolvedTargetRef,
    expectedHeadRef,
    pullRequest: {
      number: matchingPullRequest.number,
      url: matchingPullRequest.html_url || matchingPullRequest.url || "",
      headRef: matchingPullRequest.head?.ref || "",
      baseRef: matchingPullRequest.base?.ref || "",
      mergedAt: matchingPullRequest.merged_at || "",
    },
  };
}

export function verifyPublishChannelRef({
  sourceRef = "",
  sourceSha = "",
  targetRef = "",
  targetSha = "",
} = {}) {
  const parsed = parsePublishSourceRef(sourceRef);
  const resolvedTargetRef = resolvePublishChannelTargetRef({
    sourceRef,
    targetRef,
  });
  if (!parsed.enabled || parsed.anchor || !resolvedTargetRef) {
    return {
      ok: true,
      skipped: true,
      sourceRef: parsed.sourceRef || normalizeGitRefName(sourceRef),
      targetRef: resolvedTargetRef,
      reason: !parsed.enabled
        ? "publish source ref is not configured"
        : parsed.anchor
          ? "publish-gate/anchor has no channel target ref"
          : "publish target channel ref is not configured",
    };
  }
  const expected = assertSha(sourceSha, "sourceSha");
  const current = assertSha(targetSha, "targetSha");
  if (expected !== current) {
    const channelHint =
      parsed.channel === "alpha" || parsed.channel === "release"
        ? `Merge the source commit through the channel PR into ${resolvedTargetRef} before running publish verification.`
        : `Move ${resolvedTargetRef} to the reviewed source commit before running publish verification.`;
    throw new Error(
      `publish source-lock target mismatch: ${parsed.sourceRef} is locked at ${expected}, but target channel ref ${resolvedTargetRef} points at ${current}. ${channelHint}`,
    );
  }
  return {
    ok: true,
    skipped: false,
    sourceRef: parsed.sourceRef,
    sourceSha: expected,
    targetRef: resolvedTargetRef,
    targetSha: current,
  };
}
