import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENQUEUE_POLL_MS = 2_000;
const ENQUEUE_MAX_POLLS = 30;

export async function enqueueNextDevelopmentPullRequest({
  mutationOctokit,
  pull,
  headSha,
  wait,
}) {
  for (let poll = 0; poll <= ENQUEUE_MAX_POLLS; poll += 1) {
    try {
      await mutationOctokit.graphql(
        `mutation BuildchainEnqueuePullRequest($input: EnqueuePullRequestInput!) {
          enqueuePullRequest(input: $input) { mergeQueueEntry { id } }
        }`,
        { input: { pullRequestId: pull.node_id, expectedHeadOid: headSha } },
      );
      return;
    } catch (error) {
      const message = String(error?.message || "");
      if (/already.*queue|queue.*already/iu.test(message)) return;
      if (
        !/mergeability check has not yet completed/iu.test(message) ||
        poll === ENQUEUE_MAX_POLLS
      )
        throw error;
      await wait(ENQUEUE_POLL_MS);
    }
  }
}

import { spawnSyncCommand } from "../../packages/core/spawn-command.js";
import { verifyPublicationSealedBundle } from "../../packages/core/publication-sealed-bundle.js";
import { v4ContentRoot } from "../../packages/core/v4-canonical-contracts.js";
import { releaseTailRoot } from "../../packages/core/release-tail-provider-plane.js";
import {
  discoverVersionStateFiles,
  runVersionVerification,
  updateVersionStateContents,
  versionVerificationAllowedPathsForPromotion,
} from "../promote-buildchain-ref/internal/version-state.js";
import { createV4GithubProductAdapters } from "./product-provider-github-adapters.js";

const GITHUB_MUTATION_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000]);
function retryableGithubMutation(error) {
  const status = Number(
    error?.status || error?.statusCode || error?.response?.status || 0,
  );
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status === 403 && /rate limit/iu.test(error?.message || "")) return true;
  if (status) return false;
  return /^(?:ECONNABORTED|ECONNRESET|EAI_AGAIN|ENETRESET|ETIMEDOUT|UND_ERR_(?:BODY_TIMEOUT|CONNECT_TIMEOUT|HEADERS_TIMEOUT|REQ_RETRY|SOCKET))$/u.test(
    String(error?.code || ""),
  );
}
function githubMutationFailure(error) {
  if (error?.releaseTailClass) return error;
  const status = Number(
    error?.status || error?.statusCode || error?.response?.status || 0,
  );
  const failure = {
    releaseTailClass: "transient",
    releaseTailCode: status
      ? `github-mutation-${status}`
      : "github-mutation-error",
  };
  if (status) failure.status = status;
  return Object.assign(new Error("GitHub provider mutation failed"), failure);
}

export async function retryGithubMutation(wait, operation, readback) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!retryableGithubMutation(error)) throw githubMutationFailure(error);
      const observed = await readback?.();
      if (observed) return observed;
      if (attempt === GITHUB_MUTATION_RETRY_DELAYS_MS.length)
        throw githubMutationFailure(error);
      await wait(GITHUB_MUTATION_RETRY_DELAYS_MS[attempt]);
    }
  }
}
const read = (file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
function standardPublicationTarget({
  resolveStandardTarget,
  candidatePassportPath,
  candidate,
  repository,
  channel,
  sourceSha,
  declaredRef,
  declaredSha,
  expectedTransactionId,
}) {
  if (!candidatePassportPath || !channel) return null;
  try {
    const target = resolveStandardTarget({
      candidatePassportPath,
      candidate,
      repository,
      channel,
      sourceSha,
      declaredTargetRef: declaredRef,
      declaredTargetSha: declaredSha,
      expectedTransactionId,
    });
    return { sourceSha: target.targetSha, ...target };
  } catch (error) {
    const missingTarget = String(error?.message || "").includes(
      "target-ref and target-sha are required",
    );
    if (!declaredRef && !declaredSha && !expectedTransactionId && missingTarget)
      return null;
    throw error;
  }
}

function declaredPublicationTarget({ sourceSha, declaredRef, declaredSha }) {
  if (!declaredRef && !declaredSha) return null;
  if (!declaredRef || !declaredSha || sourceSha !== declaredSha)
    throw new Error(
      "declared publication target requires matching target-ref, target-sha, and source-sha",
    );
  return { sourceSha, targetRef: declaredRef, targetSha: declaredSha };
}

async function legacyPublicationTarget({
  octokit,
  repository,
  candidate,
  sourceSha,
}) {
  if (sourceSha !== candidate.source?.headSha)
    throw new Error(
      "legacy promotion target recovery requires the exact candidate source SHA",
    );
  const number = Number(candidate.pullRequest?.number || 0);
  const baseRef = String(candidate.pullRequest?.baseRef || "").trim();
  if (!Number.isSafeInteger(number) || number <= 0 || !baseRef)
    throw new Error(
      "legacy promotion target recovery requires an exact pull request and base ref",
    );
  const [owner, repo] = repository.split("/");
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: number,
  });
  const mergeSha = String(data.merge_commit_sha || "").trim();
  if (
    data.merged !== true ||
    data.base?.ref !== baseRef ||
    !/^[0-9a-f]{40}$/u.test(mergeSha)
  )
    throw new Error(
      "legacy promotion target recovery requires the exact merged pull request",
    );
  return { sourceSha: mergeSha, targetRef: baseRef, targetSha: mergeSha };
}

export async function resolvePublicationTarget(
  {
    octokit,
    repository,
    candidate,
    candidatePassportPath = "",
    channel = "",
    sourceSha,
    targetRef = "",
    targetSha = "",
    expectedTransactionId = "",
  },
  resolveStandardTarget,
) {
  const declaredRef = String(targetRef || "").trim();
  const declaredSha = String(targetSha || "").trim();
  const standard = standardPublicationTarget({
    resolveStandardTarget,
    candidatePassportPath,
    candidate,
    repository,
    channel,
    sourceSha,
    declaredRef,
    declaredSha,
    expectedTransactionId,
  });
  if (standard) return standard;
  const declared = declaredPublicationTarget({
    sourceSha,
    declaredRef,
    declaredSha,
  });
  if (declared) return declared;
  return legacyPublicationTarget({ octokit, repository, candidate, sourceSha });
}

function providerError(message, releaseTailClass, releaseTailCode) {
  return Object.assign(new Error(message), {
    releaseTailClass,
    releaseTailCode,
  });
}

function operationFor(plan, effect) {
  const operation = plan.operations.find(
    ({ id }) => id === effect.capabilityId,
  );
  if (
    !operation ||
    operation.adapter !== effect.adapter ||
    operation.operationRoot !== effect.targetRoot
  )
    throw providerError(
      `effect does not match rooted product operation ${effect.capabilityId}`,
      "conflict",
      "rooted-product-operation-mismatch",
    );
  return operation;
}

function observed(effect, evidence) {
  return {
    outcome: "observed",
    subjectRoot: effect.subjectRoot,
    targetRoot: effect.targetRoot,
    providerCode: "rooted-product-effect-observed",
    evidenceRoots: [releaseTailRoot(evidence)],
  };
}

function absent(code) {
  return { outcome: "absent", providerCode: code, evidenceRoots: [] };
}

function conflict(code) {
  return { outcome: "conflict", providerCode: code, evidenceRoots: [] };
}

function unsupported(label, value) {
  throw providerError(
    `v4 product publication does not support ${label} '${value}'`,
    "conflict",
    `unsupported-${label.replaceAll(" ", "-")}`,
  );
}

function validateProviderRequest(request, intent) {
  const artifactKind = String(intent.artifactKind || "npm").trim();
  const publishCommand = String(request.publishCommand || "").trim();
  const publishMode = String(request.publishMode || "").trim();
  const publishAuth = String(
    request.publishAuth || "trusted-publishing",
  ).trim();
  const publishDistTag = String(request.publishDistTag || "").trim();
  const packageSetOrder = String(
    request.publishPackageSetOrder || "as-provided",
  ).trim();
  const packageMain = String(
    request.publishPackageMain || intent.packageName,
  ).trim();
  if (publishCommand) unsupported("publish command", publishCommand);
  if (publishMode) unsupported("publish mode", publishMode);
  if (artifactKind === "npm" && publishAuth !== "trusted-publishing")
    unsupported("publish auth", publishAuth);
  if (
    artifactKind === "npm" &&
    publishDistTag &&
    publishDistTag !== intent.distTag
  )
    throw providerError(
      `publish dist-tag ${publishDistTag} conflicts with rooted ${intent.distTag}`,
      "conflict",
      "publish-dist-tag-conflict",
    );
  if (packageSetOrder !== "as-provided")
    unsupported("package set order", packageSetOrder);
  if (artifactKind === "npm" && packageMain !== intent.packageName)
    throw providerError(
      `main package ${packageMain} conflicts with rooted ${intent.packageName}`,
      "conflict",
      "publish-package-main-conflict",
    );
}

export function localVersionFiles(cwd, intent) {
  const discovered = discoverVersionStateFiles(cwd);
  if (discovered.files.length === 0)
    throw new Error("v4 product publication requires package version state");
  const changedFiles = updateVersionStateContents(
    discovered.files,
    intent.version,
  );
  const allowedPaths = versionVerificationAllowedPathsForPromotion(
    intent.channel === "alpha" ? "alpha" : "release",
    discovered.files.map(({ path: filePath }) => filePath),
  );
  const snapshots = new Map(
    allowedPaths.map((filePath) => {
      const resolved = path.resolve(cwd, filePath);
      return [
        resolved,
        fs.existsSync(resolved) ? fs.readFileSync(resolved) : null,
      ];
    }),
  );
  try {
    return runVersionVerification({
      cwd,
      command: "",
      loadedConfig: discovered.config,
      version: intent.version,
      changedFiles,
      allowedPaths,
      env: {
        BUILDCHAIN_SOURCE_SHA: intent.sourceSha,
        BUILDCHAIN_SITE_GENERATED_AT: intent.sourceTimestamp,
        BUILDCHAIN_SITE_PUBLISHED_AT: intent.sourceTimestamp,
        BUILDCHAIN_SURFACE_GENERATED_AT: intent.sourceTimestamp,
        BUILDCHAIN_SURFACE_PUBLISHED_AT: intent.sourceTimestamp,
      },
      runLifecycleVerify: false,
    });
  } finally {
    for (const [resolved, bytes] of snapshots) {
      if (bytes === null) fs.rmSync(resolved, { force: true });
      else fs.writeFileSync(resolved, bytes);
    }
  }
}

function withVersionFiles(cwd, files, callback) {
  const snapshots = files.map((file) => {
    const resolved = path.resolve(cwd, file.path);
    return {
      resolved,
      bytes: fs.existsSync(resolved) ? fs.readFileSync(resolved) : null,
    };
  });
  try {
    for (const [index, file] of files.entries()) {
      fs.mkdirSync(path.dirname(snapshots[index].resolved), {
        recursive: true,
      });
      fs.writeFileSync(snapshots[index].resolved, file.content);
    }
    return callback();
  } finally {
    for (const snapshot of snapshots) {
      if (snapshot.bytes === null)
        fs.rmSync(snapshot.resolved, { force: true });
      else fs.writeFileSync(snapshot.resolved, snapshot.bytes);
    }
  }
}

function commandResult(spawn, command, args, options, label) {
  const result = spawn(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw providerError(
      `${label} failed: ${String(result.stderr || result.stdout || "").trim()}`,
      "transient",
      `${label.replaceAll(" ", "-")}-failed`,
    );
  return result;
}

function requiredProductArtifacts(request, intent) {
  const requiredArtifacts = JSON.parse(
    fs.readFileSync(path.resolve(request.requiredArtifactsPath), "utf8"),
  );
  if (
    v4ContentRoot("v4-product-required-artifacts", requiredArtifacts) !==
    intent.requiredArtifactsRoot
  )
    throw new Error("required product artifacts drifted from QUALIFY intent");
  const artifactKind = String(intent.artifactKind || "npm").trim();
  const matchingArtifacts = requiredArtifacts.filter(
    ({ kind, required }) => kind === artifactKind && required !== false,
  );
  if (
    artifactKind === "npm" &&
    (matchingArtifacts.length !== 1 ||
      matchingArtifacts[0].name !== intent.packageName)
  )
    throw new Error(
      "v4 product publication currently requires one exact main npm artifact",
    );
  if (artifactKind === "custom" && matchingArtifacts.length === 0)
    throw new Error(
      "v4 custom product publication requires at least one exact required artifact",
    );
  return requiredArtifacts;
}

function verifyRootedBundle(request, intent) {
  const sealedManifest = JSON.parse(
    fs.readFileSync(path.resolve(request.sealedBundleManifest), "utf8"),
  );
  const sealedBundle = verifyPublicationSealedBundle({
    bundleRoot: request.sealedBundleRoot,
    manifest: sealedManifest,
  });
  if (
    sealedBundle.root !== intent.sealedBundleRoot ||
    sealedBundle.npm.name !== intent.packageName ||
    (intent.channel === "alpha" && sealedBundle.npm.version !== intent.version)
  )
    throw new Error("sealed product bundle drifted from QUALIFY intent");
  return sealedBundle;
}

function createPackedPackage(context) {
  let packed;
  return () => {
    if (packed) return packed;
    if (context.intent.channel === "alpha") {
      packed = {
        tarballPath: context.sealedBundle.npm.absolutePath,
        integrity: context.sealedBundle.npm.integrity,
        sha256: context.sealedBundle.npm.sha256,
      };
      return packed;
    }
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "buildchain-v4-product-"),
    );
    packed = withVersionFiles(context.cwd, context.versionFiles, () => {
      const result = commandResult(
        context.spawn,
        "npm",
        [
          "pack",
          "--json",
          "--pack-destination",
          temporaryRoot,
          "--registry=https://registry.npmjs.org/",
        ],
        { cwd: context.cwd, encoding: "utf8" },
        "npm pack",
      );
      const payload = JSON.parse(String(result.stdout || "[]"));
      const pack = Array.isArray(payload) ? payload[0] : payload;
      if (
        pack?.name !== context.intent.packageName ||
        pack?.version !== context.intent.version ||
        !pack?.filename
      )
        throw new Error("rematerialized npm package identity mismatch");
      const tarballPath = path.join(temporaryRoot, pack.filename);
      const bytes = fs.readFileSync(tarballPath);
      return {
        tarballPath,
        integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
    });
    return packed;
  };
}

const NPM_POST_PUBLISH_READBACK_DELAYS_MS = Object.freeze([
  0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
]);

async function npmReadback(context, packedPackage, effect) {
  operationFor(context.plan, effect);
  const expected = packedPackage();
  const delays = context.packageEffectAttempted
    ? NPM_POST_PUBLISH_READBACK_DELAYS_MS
    : [0];
  for (const [index, delayMs] of delays.entries()) {
    if (delayMs > 0) await context.wait(delayMs);
    const result = context.spawn(
      "npm",
      [
        "view",
        `${context.intent.packageName}@${context.intent.version}`,
        "dist.integrity",
        "--json",
        "--prefer-online",
        "--registry=https://registry.npmjs.org/",
      ],
      { cwd: context.cwd, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      if (/\bE404\b|404 Not Found|is not in this registry/iu.test(output)) {
        if (index + 1 < delays.length) continue;
        return absent("npm-version-absent");
      }
      throw providerError(
        `npm readback failed: ${output.trim()}`,
        "transient",
        "npm-readback-failed",
      );
    }
    const integrity = JSON.parse(String(result.stdout || '""'));
    if (integrity !== expected.integrity)
      return conflict("npm-integrity-conflict");
    return observed(effect, {
      kind: "npm-package",
      packageName: context.intent.packageName,
      version: context.intent.version,
      integrity,
      sha256: expected.sha256,
    });
  }
  return absent("npm-version-absent");
}

function npmApply(context, packedPackage, effect) {
  operationFor(context.plan, effect);
  const pack = packedPackage();
  context.packageEffectAttempted = true;
  commandResult(
    context.spawn,
    "npm",
    [
      "publish",
      pack.tarballPath,
      "--provenance",
      "--access",
      "public",
      "--tag",
      context.intent.distTag,
      "--registry=https://registry.npmjs.org/",
    ],
    { cwd: context.cwd, encoding: "utf8", stdio: "inherit" },
    "npm publish",
  );
  context.updates.push({
    action: "published-package",
    version: context.intent.version,
    tag: context.intent.distTag,
  });
}

export function createV4ProductPublicationAdapters({
  request,
  intent,
  plan,
  cwd = process.cwd(),
  spawn = spawnSyncCommand,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) {
  validateProviderRequest(request, intent);
  requiredProductArtifacts(request, intent);
  const sealedBundle =
    (intent.artifactKind || "npm") === "npm"
      ? verifyRootedBundle(request, intent)
      : undefined;
  const context = {
    request,
    intent,
    plan,
    cwd,
    spawn,
    sealedBundle,
    versionFiles:
      intent.channel === "alpha" ? [] : localVersionFiles(cwd, intent),
    packageEffectAttempted: false,
    wait,
    githubMutation: (operation, readback) =>
      retryGithubMutation(wait, operation, readback),
    updates: [],
  };
  const packedPackage = createPackedPackage(context);
  const github = createV4GithubProductAdapters(context);
  const npmAdapters =
    (intent.artifactKind || "npm") === "npm"
      ? {
          "npm-trusted-publishing": {
            readback: (effect) => npmReadback(context, packedPackage, effect),
            apply: (effect) => npmApply(context, packedPackage, effect),
          },
        }
      : {};
  return {
    adapters: {
      ...github.adapters,
      ...npmAdapters,
    },
    updates: context.updates,
    resolveReleaseSha: github.resolveReleaseSha,
  };
}
