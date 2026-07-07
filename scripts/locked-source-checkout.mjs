#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LOCKED_SOURCE_CHECKOUT_CONTRACT = "kungfu-buildchain-locked-source-checkout-cache";

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function nowIso() {
  return new Date().toISOString();
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function readEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function assertSha(value, label) {
  const sha = String(value || "").trim();
  if (!GIT_SHA_PATTERN.test(sha)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return sha;
}

function normalizeMode(value = "off") {
  const mode = String(value || "off").trim().toLowerCase() || "off";
  if (!["off", "auto", "require"].includes(mode)) {
    throw new Error(`checkout-cache-mode must be off, auto, or require; got ${value}`);
  }
  return mode;
}

function normalizeFallback(value = "github") {
  const fallback = String(value || "github").trim().toLowerCase() || "github";
  if (!["github", "fail"].includes(fallback)) {
    throw new Error(`checkout-cache-fallback must be github or fail; got ${value}`);
  }
  return fallback;
}

function splitRepository(repository) {
  const match = String(repository || "").trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`repository must be owner/repo, got ${repository || "<empty>"}`);
  }
  return { owner: match[1], repo: match[2], repository: `${match[1]}/${match[2]}` };
}

function renderTemplate(template = "", { owner, repo, repository, sha }) {
  return String(template || "")
    .replaceAll("{owner}", owner)
    .replaceAll("{repo}", repo)
    .replaceAll("{repository}", repository)
    .replaceAll("{repositorySlug}", repository.replaceAll("/", "-"))
    .replaceAll("{sha}", sha);
}

function sanitizeIdentity(value = "") {
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

function ensureCheckoutTarget(targetPath, workspace) {
  const resolvedWorkspace = path.resolve(workspace || process.cwd());
  const resolvedTarget = path.resolve(resolvedWorkspace, targetPath || ".");
  const relative = path.relative(resolvedWorkspace, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`checkout path must stay inside the workspace: ${targetPath}`);
  }
  fs.mkdirSync(resolvedTarget, { recursive: true });
  for (const entry of fs.readdirSync(resolvedTarget)) {
    if ((relative === "" || relative === ".") && entry === ".buildchain") {
      continue;
    }
    fs.rmSync(path.join(resolvedTarget, entry), { recursive: true, force: true });
  }
  return resolvedTarget;
}

function git(args, { cwd, env = {}, timeoutMs = 60000, stdio = ["ignore", "pipe", "pipe"] } = {}) {
  try {
    const output = execFileSync("git", args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio,
      timeout: timeoutMs,
    });
    return output ? String(output).trim() : "";
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    const stdout = error?.stdout ? String(error.stdout).trim() : "";
    const detail = [stderr, stdout].filter(Boolean).join("\n").trim();
    if (detail && !String(error.message || "").includes(detail)) {
      error.message = `${error.message}\n${detail}`;
    }
    throw error;
  }
}

function githubAuthEnv(token = "") {
  if (!token) {
    return {};
  }
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
  };
}

function markSafeDirectory(targetPath, timeoutMs) {
  try {
    git(["config", "--global", "--add", "safe.directory", path.resolve(targetPath)], {
      cwd: targetPath,
      timeoutMs,
      stdio: "ignore",
    });
  } catch {
    // Git safe.directory is best-effort. If the runner disallows global config,
    // the next git command will fail with the original actionable error.
  }
}

function gitObjectDirectory(referencePath) {
  if (!referencePath) {
    return "";
  }
  const resolved = path.resolve(referencePath);
  const candidates = [
    path.join(resolved, "objects"),
    path.join(resolved, ".git", "objects"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) || "";
}

function writeAlternates(targetPath, referencePath) {
  const objectDirectory = gitObjectDirectory(referencePath);
  if (!objectDirectory) {
    return false;
  }
  const alternatesPath = path.join(targetPath, ".git", "objects", "info", "alternates");
  fs.mkdirSync(path.dirname(alternatesPath), { recursive: true });
  fs.writeFileSync(alternatesPath, `${objectDirectory}\n`);
  return true;
}

function hasCommit(targetPath, sha, timeoutMs) {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`], { cwd: targetPath, timeoutMs });
    return true;
  } catch {
    return false;
  }
}

function checkoutFetchedCommit(targetPath, sha, timeoutMs) {
  git(["checkout", "--force", "--detach", sha], { cwd: targetPath, timeoutMs });
}

function fetchSha({ targetPath, remoteName, remoteUrl, sha, fetchRef, timeoutMs, env = {} }) {
  try {
    git(["remote", "remove", remoteName], { cwd: targetPath, timeoutMs, stdio: "ignore" });
  } catch {
    // The remote is optional; a fresh checkout target will not have it yet.
  }
  try {
    git(["remote", "add", remoteName, remoteUrl], { cwd: targetPath, timeoutMs });
  } catch {
    git(["remote", "set-url", remoteName, remoteUrl], { cwd: targetPath, timeoutMs });
  }
  const fetchArgs = ["fetch", "--no-tags", "--depth=1", remoteName, `+${sha}:refs/buildchain/source`];
  try {
    git(fetchArgs, { cwd: targetPath, timeoutMs, env, stdio: "ignore" });
    return;
  } catch (error) {
    if (!fetchRef) {
      throw error;
    }
  }
  git(["fetch", "--no-tags", "--depth=1", remoteName, `+${fetchRef}:refs/buildchain/source-ref`], {
    cwd: targetPath,
    timeoutMs,
    env,
    stdio: "ignore",
  });
  if (!hasCommit(targetPath, sha, timeoutMs)) {
    throw new Error(`fetched ${fetchRef}, but ${sha} is not available`);
  }
}

function githubRemoteUrl({ repository, serverUrl = "https://github.com" }) {
  const base = String(serverUrl || "https://github.com").replace(/\/+$/, "");
  return `${base}/${repository}.git`;
}

function verifyCheckout({ targetPath, sourceSha, sourceTreeSha = "" }) {
  const head = git(["rev-parse", "HEAD"], { cwd: targetPath });
  const tree = git(["rev-parse", "HEAD^{tree}"], { cwd: targetPath });
  const headOk = head === sourceSha;
  const treeOk = !sourceTreeSha || tree === sourceTreeSha;
  if (!headOk) {
    throw new Error(`locked source checkout head mismatch: expected ${sourceSha}, got ${head}`);
  }
  if (!treeOk) {
    throw new Error(`locked source checkout tree mismatch: expected ${sourceTreeSha}, got ${tree}`);
  }
  return { head, tree, headOk, treeOk };
}

function writeEvidence(filePath, evidence) {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

export function lockedSourceCheckout({
  workspace = process.cwd(),
  checkoutPath = ".",
  repository = readEnv("GITHUB_REPOSITORY"),
  sourceSha = readEnv("BUILDCHAIN_SOURCE_SHA"),
  sourceTreeSha = readEnv("BUILDCHAIN_SOURCE_TREE_SHA"),
  fetchRef = readEnv("BUILDCHAIN_SOURCE_REF", readEnv("GITHUB_REF")),
  mode = readEnv("BUILDCHAIN_CHECKOUT_CACHE_MODE", "off"),
  mirrorUrlTemplate = readEnv("BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE"),
  referenceRepositoryTemplate = readEnv("BUILDCHAIN_CHECKOUT_CACHE_REFERENCE_REPOSITORY_TEMPLATE"),
  fallback = readEnv("BUILDCHAIN_CHECKOUT_CACHE_FALLBACK", "github"),
  timeoutSeconds = Number(readEnv("BUILDCHAIN_CHECKOUT_CACHE_TIMEOUT_SECONDS", "60") || 60),
  diagnosticsPath = readEnv("BUILDCHAIN_SOURCE_CHECKOUT_DIAGNOSTICS_PATH", ".buildchain/diagnostics/source-checkout.json"),
  githubToken = readEnv("GITHUB_TOKEN"),
  githubServerUrl = readEnv("GITHUB_SERVER_URL", "https://github.com"),
  githubRemote = "",
  now = nowIso,
} = {}) {
  const startedAt = Date.now();
  const normalizedMode = normalizeMode(mode);
  const normalizedFallback = normalizeFallback(fallback);
  const sha = assertSha(sourceSha, "sourceSha");
  const treeSha = sourceTreeSha ? assertSha(sourceTreeSha, "sourceTreeSha") : "";
  const repoParts = splitRepository(repository);
  const timeoutMs = Math.max(1, Number(timeoutSeconds || 60)) * 1000;
  const targetPath = ensureCheckoutTarget(checkoutPath, workspace);
  git(["init"], { cwd: targetPath, timeoutMs });
  const renderedMirrorUrl = renderTemplate(mirrorUrlTemplate, { ...repoParts, sha });
  const renderedReferenceRepository = renderTemplate(referenceRepositoryTemplate, { ...repoParts, sha });
  markSafeDirectory(targetPath, timeoutMs);
  const evidence = {
    schemaVersion: 1,
    contract: LOCKED_SOURCE_CHECKOUT_CONTRACT,
    generatedAt: now(),
    repository: repoParts.repository,
    checkoutPath: path.relative(path.resolve(workspace), targetPath).split(path.sep).join("/") || ".",
    source: {
      sha,
      treeSha,
      fetchRef: fetchRef || "",
    },
    policy: {
      mode: normalizedMode,
      fallback: normalizedFallback,
      timeoutSeconds: Math.max(1, Number(timeoutSeconds || 60)),
      mirror: sanitizeIdentity(renderedMirrorUrl),
      referenceRepository: sanitizeIdentity(renderedReferenceRepository),
    },
    cache: {
      attempted: normalizedMode !== "off",
      hit: false,
      transport: "github",
      fallbackUsed: normalizedMode === "off",
      fallbackReason: normalizedMode === "off" ? "cache disabled" : "",
    },
    verification: {
      head: "",
      tree: "",
      headOk: false,
      treeOk: false,
    },
    durationMs: 0,
  };
  let checkoutError;
  if (normalizedMode !== "off") {
    try {
      if (renderedReferenceRepository) {
        const alternates = writeAlternates(targetPath, renderedReferenceRepository);
        evidence.cache.transport = "reference-repository";
        evidence.cache.referenceAvailable = alternates;
        if (!alternates) {
          throw new Error("reference repository is unavailable");
        }
        if (!hasCommit(targetPath, sha, timeoutMs)) {
          throw new Error("reference repository does not contain source commit");
        }
        checkoutFetchedCommit(targetPath, sha, timeoutMs);
      } else if (renderedMirrorUrl) {
        evidence.cache.transport = "mirror-url";
        fetchSha({
          targetPath,
          remoteName: "buildchain-cache",
          remoteUrl: renderedMirrorUrl,
          sha,
          fetchRef,
          timeoutMs,
        });
        checkoutFetchedCommit(targetPath, sha, timeoutMs);
      } else {
        throw new Error("checkout cache is enabled but no mirror URL or reference repository template was provided");
      }
      evidence.cache.hit = true;
      evidence.cache.fallbackUsed = false;
    } catch (error) {
      checkoutError = error;
      evidence.cache.hit = false;
      evidence.cache.fallbackReason = error.message;
      if (normalizedMode === "require" || normalizedFallback === "fail") {
        evidence.durationMs = Date.now() - startedAt;
        writeEvidence(path.resolve(workspace, diagnosticsPath), evidence);
        throw new Error(`locked source checkout cache unavailable: ${error.message}`);
      }
    }
  }
  if (!evidence.cache.hit) {
    const remoteUrl = githubRemote || githubRemoteUrl({ repository: repoParts.repository, serverUrl: githubServerUrl });
    evidence.cache.transport = "github";
    evidence.cache.fallbackUsed = normalizedMode !== "off";
    evidence.cache.github = sanitizeIdentity(remoteUrl);
    if (!evidence.cache.fallbackReason && checkoutError) {
      evidence.cache.fallbackReason = checkoutError.message;
    }
    fetchSha({
      targetPath,
      remoteName: "origin",
      remoteUrl,
      sha,
      fetchRef,
      timeoutMs,
      env: githubAuthEnv(githubToken),
    });
    checkoutFetchedCommit(targetPath, sha, timeoutMs);
  }
  evidence.verification = verifyCheckout({ targetPath, sourceSha: sha, sourceTreeSha: treeSha });
  evidence.durationMs = Date.now() - startedAt;
  writeEvidence(path.resolve(workspace, diagnosticsPath), evidence);
  return evidence;
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  try {
    const evidence = lockedSourceCheckout();
    console.log(`locked-source-checkout=${evidence.cache.hit ? "cache-hit" : evidence.cache.fallbackUsed ? "fallback" : "github"}`);
    console.log(`locked-source-checkout-sha=${evidence.verification.head}`);
    console.log(`locked-source-checkout-tree=${evidence.verification.tree}`);
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
