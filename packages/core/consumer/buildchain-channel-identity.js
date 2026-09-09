const EXACT_SHA_RE = /^[0-9a-f]{40}$/i;
const OFFICIAL_REF_RE = /^v(\d+)(?:\.\d+)?(-alpha)?$/;
const STABLE_RELEASE_RE = /^v(\d+)\.\d+\.\d+$/;
const ALPHA_RELEASE_RE = /^v(\d+)\.\d+\.\d+-alpha\.\d+$/;
const TRAIN_REF_RE = /^train\/v(\d+)\/v(\d+)\.\d+\/[A-Za-z0-9._/-]+$/;
const AUTHORITY_REF_RE = /^authority\/v(\d+)\/v(\d+)\.\d+\/[A-Za-z0-9._/-]+$/;

export const BUILDCHAIN_CHANNELS = new Set(["stable", "alpha"]);

export function normalizeBuildchainRef(ref = "") {
  const value = String(ref || "").trim();
  const workflowRef = value.includes("/.github/workflows/") ? value.split("@").pop() || "" : value;
  return workflowRef.replace(/^refs\/(?:heads|tags)\//, "");
}

export function parseBuildchainRefIdentity(ref = "") {
  const value = normalizeBuildchainRef(ref);
  if (!value) return { ref: value, kind: "missing", channel: null, major: null };
  if (EXACT_SHA_RE.test(value)) return { ref: value, kind: "exact-sha", channel: null, major: null };

  for (const [pattern, channel, kind] of [
    [OFFICIAL_REF_RE, null, "official-channel"],
    [STABLE_RELEASE_RE, "stable", "release"],
    [ALPHA_RELEASE_RE, "alpha", "release"],
  ]) {
    const match = value.match(pattern);
    if (match) {
      return {
        ref: value,
        kind,
        channel: channel || (match[2] ? "alpha" : "stable"),
        major: Number(match[1]),
      };
    }
  }

  for (const [pattern, kind] of [
    [TRAIN_REF_RE, "train"],
    [AUTHORITY_REF_RE, "authority"],
  ]) {
    const match = value.match(pattern);
    if (match) {
      return {
        ref: value,
        kind,
        channel: null,
        major: Number(match[1]),
        coherentMajor: match[1] === match[2],
      };
    }
  }
  return { ref: value, kind: "development", channel: null, major: null };
}

function expectedIdentity({ workflowShellRef, expectedChannel, expectedMajor }) {
  const shell = parseBuildchainRefIdentity(workflowShellRef);
  const channel =
    String(expectedChannel || "")
      .trim()
      .toLowerCase() || shell.channel;
  const majorText = String(expectedMajor ?? "").trim();
  const major = majorText ? Number(majorText.replace(/^v/, "")) : shell.major;
  return { shell, channel, major };
}

function expectedReasons(expected, { expectedChannel, expectedMajor }) {
  const reasons = [];
  if (!BUILDCHAIN_CHANNELS.has(expected.channel)) reasons.push("Buildchain channel is missing or ambiguous");
  if (!Number.isInteger(expected.major) || expected.major < 1) reasons.push("Buildchain major is missing or ambiguous");
  if (expected.shell.channel && expected.shell.channel !== expected.channel) {
    reasons.push(`workflow shell ${expected.shell.ref} is ${expected.shell.channel}, expected ${expected.channel}`);
  }
  if (Number.isInteger(expected.shell.major) && expected.shell.major !== expected.major) {
    reasons.push(`workflow shell ${expected.shell.ref} is v${expected.shell.major}, expected v${expected.major}`);
  }
  if (!expected.shell.channel && (!expectedChannel || !expectedMajor)) {
    reasons.push(`workflow shell ${expected.shell.ref || "(missing)"} does not declare a stable or alpha channel`);
  }
  return reasons;
}

function runtimeReasons(expected, runtime, allowOpaqueRuntime) {
  if (runtime.channel) {
    return [runtime.channel !== expected.channel ? `runtime ${runtime.ref} is ${runtime.channel}, expected ${expected.channel}` : "", runtime.major !== expected.major ? `runtime ${runtime.ref} is v${runtime.major}, expected v${expected.major}` : ""].filter(Boolean);
  }
  if (new Set(["train", "authority", "exact-sha"]).has(runtime.kind) && allowOpaqueRuntime) {
    return [runtime.coherentMajor === false ? `runtime ${runtime.ref} has inconsistent major segments` : "", Number.isInteger(runtime.major) && runtime.major !== expected.major ? `runtime ${runtime.ref} is v${runtime.major}, expected v${expected.major}` : ""].filter(Boolean);
  }
  return [`runtime ${runtime.ref || "(missing)"} does not prove the ${expected.channel || "selected"} channel`];
}

function lockReasons(expected, lock, lockMajor, lockMajorLine) {
  if (!lock.ref) return ["Buildchain contract lock is required for a channel-bound run"];
  return [lock.channel !== expected.channel ? `contract lock ref ${lock.ref} does not prove the ${expected.channel} channel` : "", lock.major !== expected.major ? `contract lock ref ${lock.ref} does not prove major v${expected.major}` : "", lockMajorLine && lockMajor.major !== expected.major ? `contract lock major line ${lockMajor.ref} does not match v${expected.major}` : ""].filter(Boolean);
}

export function evaluateBuildchainChannelBinding({ workflowShellRef = "", runtimeRef = "", lockRef = "", lockMajorLine = "", expectedChannel = "", expectedMajor = "", allowOpaqueRuntime = false } = {}) {
  const expected = expectedIdentity({
    workflowShellRef,
    expectedChannel,
    expectedMajor,
  });
  const runtime = parseBuildchainRefIdentity(runtimeRef);
  const lock = parseBuildchainRefIdentity(lockRef);
  const lockMajor = parseBuildchainRefIdentity(lockMajorLine);
  const reasons = [...expectedReasons(expected, { expectedChannel, expectedMajor }), ...runtimeReasons(expected, runtime, allowOpaqueRuntime), ...lockReasons(expected, lock, lockMajor, lockMajorLine)];

  return {
    ok: reasons.length === 0,
    status: reasons.length === 0 ? "channel-bound" : "channel-binding-mismatch",
    channel: expected.channel || null,
    major: Number.isInteger(expected.major) ? expected.major : null,
    shell: expected.shell,
    runtime,
    lock,
    lockMajor,
    reasons,
  };
}
