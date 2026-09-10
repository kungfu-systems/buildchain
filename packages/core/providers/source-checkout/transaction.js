import fs from "node:fs";
import path from "node:path";
import {
  LOCKED_SOURCE_CHECKOUT_CONTRACT,
  nowIso,
  normalizeMode,
  normalizeFallback,
  assertSha,
  splitRepository,
  renderTemplate,
  sanitizeIdentity,
} from "./values.js";
import { createCheckoutGitOperations } from "./git.js";
import { githubAuthEnv } from "./auth.js";
import { fetchSourceCommit, runBoundedFetch } from "./fetch.js";
function githubRemoteUrl({ repository, serverUrl = "https://github.com" }) {
  const base = String(serverUrl || "https://github.com").replace(/\/+$/, "");
  return `${base}/${repository}.git`;
}

function writeEvidence(filePath, evidence) {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

function restoreCheckoutCache({
  sha,
  normalizedMode,
  normalizedFallback,
  directoryBytes,
  targetPath,
  renderedReferenceRepository,
  writeAlternates,
  evidence,
  hasCommit,
  timeoutMs,
  checkoutFetchedCommit,
  renderedMirrorUrl,
  historyMode,
  environment,
  git,
  fetchRef,
  treeSha,
  startedAt,
  workspace,
  diagnosticsPath,
}) {
  let checkoutError;
  let checkoutSha = sha;
  if (normalizedMode !== "off") {
    const cacheAttemptStartedAt = Date.now();
    const objectBytesBefore = directoryBytes(
      path.join(targetPath, ".git", "objects"),
    );
    try {
      if (renderedReferenceRepository) {
        const lookupStartedAt = Date.now();
        const alternates = writeAlternates(
          targetPath,
          renderedReferenceRepository,
        );
        evidence.cache.transport = "reference-repository";
        evidence.cache.referenceAvailable = alternates;
        if (!alternates) {
          throw new Error("reference repository is unavailable");
        }
        if (!hasCommit(targetPath, sha, timeoutMs)) {
          throw new Error(
            "reference repository does not contain source commit",
          );
        }
        evidence.cache.lookupDurationMs = Date.now() - lookupStartedAt;
        const restoreStartedAt = Date.now();
        checkoutFetchedCommit(targetPath, sha, timeoutMs);
        evidence.cache.restoreDurationMs = Date.now() - restoreStartedAt;
      } else if (renderedMirrorUrl) {
        evidence.cache.transport = "mirror-url";
        const restoreStartedAt = Date.now();
        const fetchResult = fetchSourceCommit({
          historyMode,
          environment,
          runGit: git,
          containsCommit: hasCommit,
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
        evidence.cache.restoreDurationMs = Date.now() - restoreStartedAt;
      } else {
        throw new Error(
          "checkout cache is enabled but no mirror URL or reference repository template was provided",
        );
      }
      evidence.cache.hit = true;
      evidence.cache.fallbackUsed = false;
      evidence.cache.restoredBytes = Math.max(
        0,
        directoryBytes(path.join(targetPath, ".git", "objects")) -
          objectBytesBefore,
      );
      evidence.cache.restoredBytesStatus = "observed";
      evidence.cache.restoredBytesMethod = "git-object-store-delta";
    } catch (error) {
      checkoutError = error;
      evidence.cache.hit = false;
      evidence.cache.fallbackReason = error.message;
      if (
        evidence.cache.lookupDurationMs === 0 &&
        evidence.cache.restoreDurationMs === 0
      ) {
        evidence.cache.lookupDurationMs = Date.now() - cacheAttemptStartedAt;
      }
      if (normalizedMode === "require" || normalizedFallback === "fail") {
        evidence.durationMs = Date.now() - startedAt;
        writeEvidence(path.resolve(workspace, diagnosticsPath), evidence);
        throw new Error(
          `locked source checkout cache unavailable: ${error.message}`,
        );
      }
    }
  }

  return { checkoutError, checkoutSha };
}

function initialCheckoutEvidence({
  now,
  repoParts,
  workspace,
  targetPath,
  sha,
  treeSha,
  fetchRef,
  normalizedMode,
  normalizedFallback,
  timeoutSeconds,
  githubTimeoutSeconds,
  normalizedFetchAttempts,
  renderedMirrorUrl,
  renderedReferenceRepository,
}) {
  const evidence = {
    schemaVersion: 1,
    contract: LOCKED_SOURCE_CHECKOUT_CONTRACT,
    generatedAt: now(),
    repository: repoParts.repository,
    checkoutPath:
      path
        .relative(path.resolve(workspace), targetPath)
        .split(path.sep)
        .join("/") || ".",
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
      lookupDurationMs: 0,
      restoreDurationMs: 0,
      githubFetchDurationMs: 0,
      restoredBytes: null,
      restoredBytesStatus:
        normalizedMode === "off" ? "not-applicable" : "unavailable",
      restoredBytesMethod: "",
    },
    verification: {
      head: "",
      tree: "",
      headOk: false,
      treeOk: false,
    },
    durationMs: 0,
  };

  return evidence;
}

export function lockedSourceCheckout({
  workspace,
  checkoutPath = ".",
  repository,
  sourceSha,
  sourceTreeSha = "",
  fetchRef = "",
  mode = "off",
  mirrorUrlTemplate = "",
  referenceRepositoryTemplate = "",
  fallback = "github",
  timeoutSeconds = 60,
  githubTimeoutSeconds = 600,
  fetchAttempts = 3,
  diagnosticsPath = ".buildchain/diagnostics/source-checkout.json",
  githubToken = "",
  githubServerUrl = "https://github.com",
  githubRemote = "",
  historyMode = "shallow",
  environment = process.env,
  now = nowIso,
} = {}) {
  const {
    git,
    ensureCheckoutTarget,
    directoryBytes,
    writeAlternates,
    hasCommit,
    checkoutFetchedCommit,
    verifyCheckout,
    retryableGitFetchError,
  } = createCheckoutGitOperations(environment);
  const startedAt = Date.now();
  const normalizedMode = normalizeMode(mode);
  const normalizedFallback = normalizeFallback(fallback);
  const sha = assertSha(sourceSha, "sourceSha");
  const treeSha = sourceTreeSha
    ? assertSha(sourceTreeSha, "sourceTreeSha")
    : "";
  const repoParts = splitRepository(repository);
  const timeoutMs = Math.max(1, Number(timeoutSeconds || 60)) * 1000;
  const githubTimeoutMs =
    Math.max(1, Number(githubTimeoutSeconds || 600)) * 1000;
  const normalizedFetchAttempts = Math.max(
    1,
    Math.floor(Number(fetchAttempts) || 3),
  );
  const targetPath = ensureCheckoutTarget(checkoutPath, workspace);
  git(["init"], { cwd: targetPath, timeoutMs });
  const renderedMirrorUrl = renderTemplate(mirrorUrlTemplate, {
    ...repoParts,
    sha,
  });
  const renderedReferenceRepository = renderTemplate(
    referenceRepositoryTemplate,
    { ...repoParts, sha },
  );
  const evidence = initialCheckoutEvidence({
    now,
    repoParts,
    workspace,
    targetPath,
    sha,
    treeSha,
    fetchRef,
    normalizedMode,
    normalizedFallback,
    timeoutSeconds,
    githubTimeoutSeconds,
    normalizedFetchAttempts,
    renderedMirrorUrl,
    renderedReferenceRepository,
  });
  let { checkoutError, checkoutSha } = restoreCheckoutCache({
    sha,
    normalizedMode,
    normalizedFallback,
    directoryBytes,
    targetPath,
    renderedReferenceRepository,
    writeAlternates,
    evidence,
    hasCommit,
    timeoutMs,
    checkoutFetchedCommit,
    renderedMirrorUrl,
    historyMode,
    environment,
    git,
    fetchRef,
    treeSha,
    startedAt,
    workspace,
    diagnosticsPath,
  });
  if (!evidence.cache.hit) {
    const remoteUrl =
      githubRemote ||
      githubRemoteUrl({
        repository: repoParts.repository,
        serverUrl: githubServerUrl,
      });
    evidence.cache.transport = "github";
    evidence.cache.fallbackUsed = normalizedMode !== "off";
    evidence.cache.github = sanitizeIdentity(remoteUrl);
    if (!evidence.cache.fallbackReason && checkoutError) {
      evidence.cache.fallbackReason = checkoutError.message;
    }
    try {
      const githubFetchStartedAt = Date.now();
      const fetchResult = runBoundedFetch({
        attempts: normalizedFetchAttempts,
        fetch: () =>
          fetchSourceCommit({
            historyMode,
            environment,
            runGit: git,
            containsCommit: hasCommit,
            targetPath,
            remoteName: "origin",
            remoteUrl,
            sha,
            fetchRef,
            sourceTreeSha: treeSha,
            timeoutMs: githubTimeoutMs,
            env: githubAuthEnv(githubToken),
          }),
        onAttempt: ({ attempt }) => {
          evidence.cache.githubFetchAttempts = attempt;
        },
        onRetry: ({ attempt, limit, error }) =>
          console.log(
            `buildchain: GitHub source fetch failed, retry ${attempt + 1}/${limit}: ${error.message}`,
          ),
        shouldRetry: retryableGitFetchError,
      });
      evidence.cache.githubFetchAttempts = fetchResult.attempts;
      evidence.cache.fetchMode = fetchResult.value.fetchMode;
      checkoutSha = fetchResult.value.checkoutSha || sha;
      evidence.cache.githubFetchDurationMs = Date.now() - githubFetchStartedAt;
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
