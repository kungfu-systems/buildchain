export function assertSha(sha, label = "sourceSha") {
  const value = String(sha || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return value;
}

export function normalizeGitRefName(value = "") {
  return String(value || "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/tags\//, "");
}

export function normalizeGitFullRef(value = "") {
  const ref = String(value || "").trim();
  if (!ref) {
    return "";
  }
  if (ref.startsWith("refs/")) {
    return ref;
  }
  if (/^v\d/.test(ref)) {
    return `refs/tags/${ref}`;
  }
  return `refs/heads/${ref}`;
}

export function parsePublishSourceRef(value = "") {
  const sourceRef = normalizeGitRefName(value);
  if (!sourceRef) {
    return {
      sourceRef: "",
      fullRef: "",
      enabled: false,
      channel: "none",
      line: "",
      consumerVersion: "",
      anchor: false,
    };
  }
  if (sourceRef === "publish-gate/anchor") {
    return {
      sourceRef,
      fullRef: "refs/heads/publish-gate/anchor",
      enabled: true,
      channel: "anchor",
      line: "",
      consumerVersion: "",
      anchor: true,
    };
  }
  if (sourceRef === "publish-gate/major") {
    return {
      sourceRef,
      fullRef: "refs/heads/publish-gate/major",
      enabled: true,
      channel: "major",
      line: "",
      consumerVersion: "",
      anchor: false,
    };
  }
  const match = sourceRef.match(
    /^publish-gate\/(alpha|release)\/(.+)\/([^/]+)$/,
  );
  if (!match) {
    throw new Error(
      `unsupported publish source ref: ${sourceRef}; expected publish-gate/alpha/<line>/<version>, publish-gate/release/<line>/<version>, publish-gate/anchor, or publish-gate/major`,
    );
  }
  const [, channel, line, consumerVersion] = match;
  if (!line.includes("/")) {
    throw new Error(
      `publish source line must include a major/minor path: ${sourceRef}`,
    );
  }
  if (!/^[A-Za-z0-9._+~-]+$/.test(consumerVersion)) {
    throw new Error(
      `publish source consumer version contains unsupported characters: ${consumerVersion}`,
    );
  }
  return {
    sourceRef,
    fullRef: `refs/heads/${sourceRef}`,
    enabled: true,
    channel,
    line,
    consumerVersion,
    anchor: false,
  };
}

export function resolvePublishSourceLock({
  publishSourceRef = "",
  publishSourceSha = "",
  fallbackRef = "",
  fallbackSha = "",
} = {}) {
  const parsed = parsePublishSourceRef(publishSourceRef);
  if (!parsed.enabled) {
    return {
      ...parsed,
      sourceRef: "",
      fullRef: "",
      fallbackRef: normalizeGitRefName(fallbackRef),
      fallbackFullRef: normalizeGitFullRef(fallbackRef),
      sourceSha: fallbackSha ? assertSha(fallbackSha, "fallbackSha") : "",
      sourceLocked: false,
      sourceReason: "publish source ref is not configured",
    };
  }
  return {
    ...parsed,
    sourceSha: assertSha(publishSourceSha),
    sourceLocked: true,
    sourceReason: `locked ${parsed.sourceRef} at ${publishSourceSha}`,
  };
}

export function verifyPublishSourceLock({
  sourceRef = "",
  expectedSha = "",
  currentSha = "",
} = {}) {
  const expected = assertSha(expectedSha, "expectedSha");
  const current = assertSha(currentSha, "currentSha");
  if (expected !== current) {
    throw new Error(
      `publish source ref moved: ${sourceRef || "<unknown>"} expected ${expected}, got ${current}`,
    );
  }
  return {
    ok: true,
    sourceRef,
    sourceSha: expected,
  };
}

export function resolvePublishChannelTargetRef({
  sourceRef = "",
  targetRef = "",
} = {}) {
  const requestedTarget = normalizeGitRefName(targetRef);
  if (requestedTarget) {
    return requestedTarget;
  }
  const parsed = parsePublishSourceRef(sourceRef);
  if (!parsed.enabled || parsed.anchor) {
    return "";
  }
  if (parsed.channel === "alpha" || parsed.channel === "release") {
    return `${parsed.channel}/${parsed.line}`;
  }
  if (parsed.channel === "major") {
    return "publish-gate/major";
  }
  return "";
}
