#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LOCKED_SOURCE_CHECKOUT_CONTRACT = "kungfu-buildchain-locked-source-checkout-cache";
export const ISOLATED_GIT_GLOBAL_CONFIG = process.platform === "win32" ? "NUL" : "/dev/null";

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

function isolatedGitFetchEnv(env = {}, targetPath) {
  const configuredCount = Number.parseInt(env.GIT_CONFIG_COUNT || "0", 10);
  const safeDirectoryIndex = Number.isInteger(configuredCount) && configuredCount >= 0
    ? configuredCount
    : 0;
  return {
    ...env,
    // Runner-global URL rewrites are shared mutable state. A concurrent job
    // may point the same repository URL at a different single-SHA bundle, so
    // network fetches must not consult the account-level Git config.
    GIT_CONFIG_GLOBAL: ISOLATED_GIT_GLOBAL_CONFIG,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(safeDirectoryIndex + 1),
    [`GIT_CONFIG_KEY_${safeDirectoryIndex}`]: "safe.directory",
    [`GIT_CONFIG_VALUE_${safeDirectoryIndex}`]: path.resolve(targetPath),
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
  // The locked Git tree is also the byte-level source of release evidence.
  // Override runner-global autocrlf only at checkout time so this also works
  // when a container workspace uses an external Git metadata pointer.
  git(["-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout", "--force", "--detach", sha], {
    cwd: targetPath,
    timeoutMs,
  });
}

function retryableGitFetchError(error) {
  const code = String(error?.code || "").toUpperCase();
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EPIPE"].includes(code)) return true;
  return /timed?\s*out|timeout|connection (?:reset|refused)|remote end hung up|early eof|rpc failed|http (?:429|5\d\d)|temporary failure|network is unreachable/i.test(String(error?.message || error || ""));
}

export function fetchSourceCommit({
  targetPath,
  remoteName,
  remoteUrl,
  sha,
  fetchRef,
  sourceTreeSha = "",
  timeoutMs,
  env = {},
  allowFullFetchRetry = false,
  runGit = git,
  containsCommit = hasCommit,
}) {
  const fetchEnv = isolatedGitFetchEnv(env, targetPath);
  const fetch = (refspec) => {
    const options = { cwd: targetPath, timeoutMs, env: fetchEnv };
    try {
      runGit(["fetch", "--no-tags", "--depth=1", remoteName, refspec], options);
      return "shallow";
    } catch (error) {
      if (
        !allowFullFetchRetry
        || !/dumb http transport does not support shallow capabilities/i.test(
          String(error?.message || error || ""),
        )
      ) {
        throw error;
      }
      // Dumb HTTP mirrors are intentionally simple static cache endpoints.
      // Retry only that explicit capability mismatch without --depth; all
      // network fallbacks remain shallow and bounded by their own policy.
      runGit(["fetch", "--no-tags", remoteName, refspec], options);
      return "full";
    }
  };
  try {
    runGit(["remote", "remove", remoteName], { cwd: targetPath, timeoutMs, stdio: "ignore" });
  } catch {
    // The remote is optional; a fresh checkout target will not have it yet.
  }
  try {
    runGit(["remote", "add", remoteName, remoteUrl], { cwd: targetPath, timeoutMs });
  } catch {
    runGit(["remote", "set-url", remoteName, remoteUrl], { cwd: targetPath, timeoutMs });
  }

  if (fetchRef) {
    try {
      const fetchMode = fetch(`+${fetchRef}:refs/buildchain/source-ref`);
      if (containsCommit(targetPath, sha, timeoutMs)) {
        return { selector: "ref", checkoutSha: sha, fetchMode };
      }
      if (/^refs\/pull\/\d+\/merge$/.test(fetchRef) && sourceTreeSha) {
        const fetchedSha = runGit(["rev-parse", "refs/buildchain/source-ref^{commit}"], {
          cwd: targetPath,
          timeoutMs,
        });
        const fetchedTree = runGit(["rev-parse", "refs/buildchain/source-ref^{tree}"], {
          cwd: targetPath,
          timeoutMs,
        });
        if (fetchedTree === sourceTreeSha) {
          return { selector: "ref-tree", checkoutSha: fetchedSha, fetchMode };
        }
      }
    } catch (error) {
      // A retryable transport failure belongs to the bounded outer retry. Do
      // not immediately spend the same timeout again on an unadvertised SHA.
      if (retryableGitFetchError(error)) {
        throw error;
      }
    }
  }

  const fetchMode = fetch(`+${sha}:refs/buildchain/source`);
  if (!containsCommit(targetPath, sha, timeoutMs)) {
    throw new Error(`fetched ${fetchRef || sha}, but ${sha} is not available`);
  }
  return { selector: "sha", checkoutSha: sha, fetchMode };
}

export function runBoundedFetch({ attempts = 1, fetch, onAttempt = () => {}, onRetry = () => {}, shouldRetry = () => true }) {
  const limit = Math.max(1, Math.floor(Number(attempts) || 1));
  let lastError;
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    onAttempt({ attempt, limit });
    try {
      return { value: fetch({ attempt, limit }), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= limit || !shouldRetry(error)) {
        error.fetchAttempts = attempt;
        throw error;
      }
      onRetry({ attempt, limit, error });
    }
  }
  throw lastError;
}

function githubRemoteUrl({ repository, serverUrl = "https://github.com" }) {
  const base = String(serverUrl || "https://github.com").replace(/\/+$/, "");
  return `${base}/${repository}.git`;
}

function verifyCheckout({ targetPath, sourceSha, sourceTreeSha = "", fetchRef = "" }) {
  const head = git(["rev-parse", "HEAD"], { cwd: targetPath });
  const tree = git(["rev-parse", "HEAD^{tree}"], { cwd: targetPath });
  const headOk = head === sourceSha;
  const treeOk = !sourceTreeSha || tree === sourceTreeSha;
  const pullMergeTreeEquivalent = !headOk
    && /^refs\/pull\/\d+\/merge$/.test(fetchRef)
    && Boolean(sourceTreeSha)
    && treeOk;
  if (!headOk && !pullMergeTreeEquivalent) {
    throw new Error(`locked source checkout head mismatch: expected ${sourceSha}, got ${head}`);
  }
  if (!treeOk) {
    throw new Error(`locked source checkout tree mismatch: expected ${sourceTreeSha}, got ${tree}`);
  }
  return {
    head,
    expectedHead: sourceSha,
    tree,
    headOk,
    treeOk,
    identityOk: headOk || pullMergeTreeEquivalent,
    identityMode: pullMergeTreeEquivalent ? "tree-equivalent-pull-merge" : "commit",
  };
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
  checkoutPath = readEnv("BUILDCHAIN_SOURCE_CHECKOUT_PATH", "."),
  repository = readEnv("BUILDCHAIN_SOURCE_REPOSITORY", readEnv("GITHUB_REPOSITORY")),
  sourceSha = readEnv("BUILDCHAIN_SOURCE_SHA"),
  sourceTreeSha = readEnv("BUILDCHAIN_SOURCE_TREE_SHA"),
  fetchRef = readEnv("BUILDCHAIN_SOURCE_REF", readEnv("GITHUB_REF")),
  mode = readEnv("BUILDCHAIN_CHECKOUT_CACHE_MODE", "off"),
  mirrorUrlTemplate = readEnv("BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE"),
  referenceRepositoryTemplate = readEnv("BUILDCHAIN_CHECKOUT_CACHE_REFERENCE_REPOSITORY_TEMPLATE"),
  fallback = readEnv("BUILDCHAIN_CHECKOUT_CACHE_FALLBACK", "github"),
  timeoutSeconds = Number(readEnv("BUILDCHAIN_CHECKOUT_CACHE_TIMEOUT_SECONDS", "60") || 60),
  githubTimeoutSeconds = Number(readEnv("BUILDCHAIN_CHECKOUT_CACHE_GITHUB_TIMEOUT_SECONDS", "600") || 600),
  fetchAttempts = Number(readEnv("BUILDCHAIN_CHECKOUT_CACHE_FETCH_ATTEMPTS", "3") || 3),
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
  const githubTimeoutMs = Math.max(1, Number(githubTimeoutSeconds || 600)) * 1000;
  const normalizedFetchAttempts = Math.max(1, Math.floor(Number(fetchAttempts) || 3));
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
      githubTimeoutSeconds: Math.max(1, Number(githubTimeoutSeconds || 600)),
      fetchAttempts: normalizedFetchAttempts,
      mirror: sanitizeIdentity(renderedMirrorUrl),
      referenceRepository: sanitizeIdentity(renderedReferenceRepository),
    },
    cache: {
      attempted: normalizedMode !== "off",
      hit: false,
      transport: "github",
      fallbackUsed: normalizedMode === "off",
      fallbackReason: normalizedMode === "off" ? "cache disabled" : "",
      githubFetchAttempts: 0,
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
  let checkoutSha = sha;
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
        const fetchResult = fetchSourceCommit({
          targetPath,
          remoteName: "buildchain-cache",
          remoteUrl: renderedMirrorUrl,
          sha,
          fetchRef,
          sourceTreeSha: treeSha,
          timeoutMs,
          allowFullFetchRetry: true,
        });
        evidence.cache.fetchMode = fetchResult.fetchMode;
        checkoutSha = fetchResult.checkoutSha || sha;
        checkoutFetchedCommit(targetPath, checkoutSha, timeoutMs);
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
    try {
      const fetchResult = runBoundedFetch({
        attempts: normalizedFetchAttempts,
        fetch: () => fetchSourceCommit({
          targetPath,
          remoteName: "origin",
          remoteUrl,
          sha,
          fetchRef,
          sourceTreeSha: treeSha,
          timeoutMs: githubTimeoutMs,
          env: githubAuthEnv(githubToken),
        }),
        onAttempt: ({ attempt }) => { evidence.cache.githubFetchAttempts = attempt; },
        onRetry: ({ attempt, limit, error }) => console.log(`buildchain: GitHub source fetch failed, retry ${attempt + 1}/${limit}: ${error.message}`),
        shouldRetry: retryableGitFetchError,
      });
      evidence.cache.githubFetchAttempts = fetchResult.attempts;
      evidence.cache.fetchMode = fetchResult.value.fetchMode;
      checkoutSha = fetchResult.value.checkoutSha || sha;
    } catch (error) {
      evidence.durationMs = Date.now() - startedAt;
      writeEvidence(path.resolve(workspace, diagnosticsPath), evidence);
      throw error;
    }
    checkoutFetchedCommit(targetPath, checkoutSha, timeoutMs);
  }
  evidence.verification = verifyCheckout({
    targetPath,
    sourceSha: sha,
    sourceTreeSha: treeSha,
    fetchRef,
  });
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
