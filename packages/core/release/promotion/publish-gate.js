import { parseJsonObject } from "../../contracts/structured-values.js";
export const DEFAULT_PUBLISH_REFS = Object.freeze({
  alpha: [
    "^refs/heads/alpha/v\\d+/v\\d+\\.\\d+$",
    "^refs/tags/v\\d+\\.\\d+\\.\\d+-alpha\\.\\d+$",
    "^refs/heads/publish-gate/alpha/.+/.+$",
  ],
  release: [
    "^refs/heads/release/v\\d+/v\\d+\\.\\d+$",
    "^refs/tags/v\\d+\\.\\d+\\.\\d+$",
    "^refs/tags/v\\d+\\.\\d+$",
    "^refs/tags/v\\d+$",
    "^refs/heads/publish-gate/release/.+/.+$",
  ],
  anchor: ["^refs/heads/publish-gate/anchor$"],
  major: [
    "^refs/heads/publish-gate/major$",
    "^refs/tags/v\\d+\\.0\\.0$",
    "^refs/tags/v\\d+\\.0$",
    "^refs/tags/v\\d+$",
  ],
});

export function normalizePublishRefs(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return DEFAULT_PUBLISH_REFS;
  }
  const parsed = parseJsonObject(raw, "publish-refs-json");
  const normalized = {};
  for (const [channel, patterns] of Object.entries(parsed)) {
    const key = String(channel || "").trim();
    if (!key) {
      throw new Error("publish-refs-json channel names must be non-empty");
    }
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new Error(`publish-refs-json.${key} must be a non-empty array`);
    }
    normalized[key] = patterns.map((pattern, index) => {
      const value = String(pattern || "").trim();
      if (!value) {
        throw new Error(`publish-refs-json.${key}[${index}] must be non-empty`);
      }
      try {
        new RegExp(value);
      } catch (error) {
        throw new Error(
          `publish-refs-json.${key}[${index}] is invalid: ${error.message}`,
        );
      }
      return value;
    });
  }
  return normalized;
}

export function resolvePublishGate({
  trusted = true,
  publishChannel = "none",
  eventName = "",
  ref = "",
  publishRefsJson = "",
} = {}) {
  const channel = String(publishChannel || "none").trim() || "none";
  const isTrusted = trusted === true || String(trusted) === "true";
  if (channel === "none") {
    return {
      trusted: isTrusted,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: "publish channel is none",
    };
  }
  if (channel === "anchor") {
    return {
      trusted: isTrusted,
      publishChannel: channel,
      publishAllowed: false,
      publishReason:
        "anchor gates resolve source state but do not publish artifacts",
    };
  }
  if (!isTrusted) {
    return {
      trusted: false,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: "event is not trusted",
    };
  }
  if (String(eventName || "") === "pull_request") {
    return {
      trusted: true,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: "pull_request events may verify but may not publish",
    };
  }

  const publishRefs = normalizePublishRefs(publishRefsJson);
  const patterns = publishRefs[channel];
  if (!patterns) {
    return {
      trusted: true,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: `unknown publish channel: ${channel}`,
    };
  }
  const refValue = String(ref || "");
  const matchedPattern = patterns.find((pattern) =>
    new RegExp(pattern).test(refValue),
  );
  if (!matchedPattern) {
    return {
      trusted: true,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: `ref ${refValue || "<empty>"} is not allowed for publish channel ${channel}`,
    };
  }
  return {
    trusted: true,
    publishChannel: channel,
    publishAllowed: true,
    publishReason: `ref matched ${matchedPattern}`,
  };
}
