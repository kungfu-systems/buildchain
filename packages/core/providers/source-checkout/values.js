import path from "node:path";
import crypto from "node:crypto";
export const LOCKED_SOURCE_CHECKOUT_CONTRACT =
  "kungfu-buildchain-locked-source-checkout-cache";
export const ISOLATED_GIT_GLOBAL_CONFIG =
  process.platform === "win32" ? "NUL" : "/dev/null";

export const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function nowIso() {
  return new Date().toISOString();
}

export function hashText(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

export function assertSha(value, label) {
  const sha = String(value || "").trim();
  if (!GIT_SHA_PATTERN.test(sha)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return sha;
}

export function normalizeMode(value = "off") {
  const mode =
    String(value || "off")
      .trim()
      .toLowerCase() || "off";
  if (!["off", "auto", "require"].includes(mode)) {
    throw new Error(
      `checkout-cache-mode must be off, auto, or require; got ${value}`,
    );
  }
  return mode;
}

export function normalizeFallback(value = "github") {
  const fallback =
    String(value || "github")
      .trim()
      .toLowerCase() || "github";
  if (!["github", "fail"].includes(fallback)) {
    throw new Error(
      `checkout-cache-fallback must be github or fail; got ${value}`,
    );
  }
  return fallback;
}

export function normalizeHistoryMode(value = "shallow") {
  const mode =
    String(value || "shallow")
      .trim()
      .toLowerCase() || "shallow";
  if (!["shallow", "full"].includes(mode)) {
    throw new Error(
      `checkout-history-mode must be shallow or full; got ${value}`,
    );
  }
  return mode;
}

export function splitRepository(repository) {
  const match = String(repository || "")
    .trim()
    .match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(
      `repository must be owner/repo, got ${repository || "<empty>"}`,
    );
  }
  return {
    owner: match[1],
    repo: match[2],
    repository: `${match[1]}/${match[2]}`,
  };
}

export function renderTemplate(
  template = "",
  { owner, repo, repository, sha },
) {
  return String(template || "")
    .replaceAll("{owner}", owner)
    .replaceAll("{repo}", repo)
    .replaceAll("{repository}", repository)
    .replaceAll("{repositorySlug}", repository.replaceAll("/", "-"))
    .replaceAll("{sha}", sha);
}

export function sanitizeIdentity(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return { display: "", fingerprint: "" };
  }
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return {
      display: url.toString(),
      fingerprint: hashText(raw).slice(0, 16),
    };
  } catch {
    return {
      display: path.basename(raw.replace(/[\\/]+$/, "")) || "reference",
      fingerprint: hashText(raw).slice(0, 16),
    };
  }
}
