import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const read = (file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

function standardCandidatePath(
  candidatePassportPath,
  declaredPath,
  relativePath,
  label,
) {
  if (String(declaredPath || "").trim()) return declaredPath;
  const fallback = path.join(
    path.dirname(candidatePassportPath),
    "..",
    relativePath,
  );
  if (!fs.existsSync(path.resolve(fallback)))
    throw new Error(
      `${label} is required when the sealed candidate has no standard ${relativePath}`,
    );
  return fallback;
}

export function resolveCandidateProviderInputs({
  candidatePassportPath,
  sealedBundleRoot = "",
  sealedBundleManifest = "",
  requiredArtifactsPath = "",
  publishPackageMain = "",
}) {
  const resolved = {
    sealedBundleRoot: standardCandidatePath(
      candidatePassportPath,
      sealedBundleRoot,
      "payloads",
      "sealed-bundle-root",
    ),
    sealedBundleManifest: standardCandidatePath(
      candidatePassportPath,
      sealedBundleManifest,
      "sealed-bundle.json",
      "sealed-bundle-manifest",
    ),
    requiredArtifactsPath: standardCandidatePath(
      candidatePassportPath,
      requiredArtifactsPath,
      "publish-required-artifacts.json",
      "required-artifacts-path",
    ),
    publishPackageMain: String(publishPackageMain || "").trim(),
  };
  const recoveryReceiptPath = path.join(
    path.dirname(resolved.sealedBundleManifest),
    "recovery-receipt.json",
  );
  if (fs.existsSync(path.resolve(recoveryReceiptPath)))
    resolved.releaseCandidateRecoveryReceiptPath = recoveryReceiptPath;
  if (!resolved.publishPackageMain) {
    const main = read(resolved.requiredArtifactsPath).filter(
      ({ role }) => role === "main",
    );
    if (main.length !== 1 || !String(main[0]?.name || "").trim())
      throw new Error(
        "publish-package-main is required when the sealed artifact set has no unique main package",
      );
    resolved.publishPackageMain = String(main[0].name).trim();
  }
  return resolved;
}

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
  if (publishAuth !== "trusted-publishing")
    unsupported("publish auth", publishAuth);
  if (publishDistTag && publishDistTag !== intent.distTag)
    throw providerError(
      `publish dist-tag ${publishDistTag} conflicts with rooted ${intent.distTag}`,
      "conflict",
      "publish-dist-tag-conflict",
    );
  if (packageSetOrder !== "as-provided")
    unsupported("package set order", packageSetOrder);
  if (packageMain !== intent.packageName)
    throw providerError(
      `main package ${packageMain} conflicts with rooted ${intent.packageName}`,
      "conflict",
      "publish-package-main-conflict",
    );
}

function localVersionFiles(cwd, intent) {
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
  const npmArtifacts = requiredArtifacts.filter(
    ({ kind, required }) => kind === "npm" && required !== false,
  );
  if (npmArtifacts.length !== 1 || npmArtifacts[0].name !== intent.packageName)
    throw new Error(
      "v4 product publication currently requires one exact main npm artifact",
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
    sealedBundle.npm.name !== intent.packageName
  )
    throw new Error("sealed product bundle drifted from QUALIFY intent");
  return sealedBundle;
}

function createPackedPackage(context) {
  let packed;
  return () => {
    if (packed) return packed;
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

function npmReadback(context, packedPackage, effect) {
  operationFor(context.plan, effect);
  const expected = packedPackage();
  const result = context.spawn(
    "npm",
    [
      "view",
      `${context.intent.packageName}@${context.intent.version}`,
      "dist.integrity",
      "--json",
      "--registry=https://registry.npmjs.org/",
    ],
    { cwd: context.cwd, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (/\bE404\b|404 Not Found|is not in this registry/iu.test(output))
      return absent("npm-version-absent");
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

function npmApply(context, packedPackage, effect) {
  operationFor(context.plan, effect);
  const pack = packedPackage();
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
}) {
  validateProviderRequest(request, intent);
  requiredProductArtifacts(request, intent);
  verifyRootedBundle(request, intent);
  const context = {
    request,
    intent,
    plan,
    cwd,
    spawn,
    versionFiles: localVersionFiles(cwd, intent),
    updates: [],
  };
  const packedPackage = createPackedPackage(context);
  const github = createV4GithubProductAdapters(context);
  return {
    adapters: {
      ...github.adapters,
      "npm-trusted-publishing": {
        readback: (effect) => npmReadback(context, packedPackage, effect),
        apply: (effect) => npmApply(context, packedPackage, effect),
      },
    },
    updates: context.updates,
    resolveReleaseSha: github.resolveReleaseSha,
  };
}
