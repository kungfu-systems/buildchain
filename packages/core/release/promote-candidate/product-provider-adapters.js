import { parseNpmView } from "../../publication/npm/registry.js";
import { readNpmPackResult } from "../../publication/npm/pack-result.js";
import { createOciPublicationAdapter } from "./oci-provider.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export { enqueueNextDevelopmentPullRequest } from "./next-development-queue.js";

import { spawnSyncCommand } from "../../runtime/spawn-command.js";
import { verifyPublicationSealedBundle } from "../../publication/publication-sealed-bundle.js";
import { domainContentRoot } from "../../contracts/canonical-contracts.js";
import { releaseTailRoot } from "../release-tail-provider-plane.js";
import {
  discoverVersionStateFiles,
  runVersionVerification,
  updateVersionStateContents,
  versionVerificationAllowedPathsForPromotion,
} from "../version-state.js";
import { createGithubProductAdapters } from "./product-provider-github-adapters.js";

const GITHUB_MUTATION_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000]);
function retryableGithubMutation(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status === 403 && /rate limit/iu.test(error?.message || "")) return true;
  if (status) return false;
  return /^(?:ECONNABORTED|ECONNRESET|EAI_AGAIN|ENETRESET|ETIMEDOUT|UND_ERR_(?:BODY_TIMEOUT|CONNECT_TIMEOUT|HEADERS_TIMEOUT|REQ_RETRY|SOCKET))$/u.test(
    String(error?.code || ""),
  );
}
function githubMutationFailure(error) {
  if (error?.releaseTailClass) return error;
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  const failure = {
    releaseTailClass: "transient",
    releaseTailCode: status ? `github-mutation-${status}` : "github-mutation-error",
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
      if (attempt === GITHUB_MUTATION_RETRY_DELAYS_MS.length) throw githubMutationFailure(error);
      await wait(GITHUB_MUTATION_RETRY_DELAYS_MS[attempt]);
    }
  }
}
const read = (file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
function providerError(message, releaseTailClass, releaseTailCode) {
  return Object.assign(new Error(message), {
    releaseTailClass,
    releaseTailCode,
  });
}

function operationFor(plan, effect) {
  const operation = plan.operations.find(({ id }) => id === effect.capabilityId);
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
  const publishAuth = String(request.publishAuth || "trusted-publishing").trim();
  const publishDistTag = String(request.publishDistTag || "").trim();
  const packageSetOrder = String(request.publishPackageSetOrder || "as-provided").trim();
  const packageMain = String(request.publishPackageMain || intent.packageName).trim();
  if (publishCommand) unsupported("publish command", publishCommand);
  if (publishMode) unsupported("publish mode", publishMode);
  if (artifactKind === "npm" && publishAuth !== "trusted-publishing")
    unsupported("publish auth", publishAuth);
  if (artifactKind === "npm" && publishDistTag && publishDistTag !== intent.distTag)
    throw providerError(
      `publish dist-tag ${publishDistTag} conflicts with rooted ${intent.distTag}`,
      "conflict",
      "publish-dist-tag-conflict",
    );
  if (
    packageSetOrder !== "as-provided" &&
    !(intent.npmPackages && packageSetOrder === "platforms-first-main-last")
  )
    unsupported("package set order", packageSetOrder);
  if (artifactKind === "npm" && packageMain !== intent.packageName)
    throw providerError(
      `main package ${packageMain} conflicts with rooted ${intent.packageName}`,
      "conflict",
      "publish-package-main-conflict",
    );
}

function snapshotVersionFiles(cwd, paths) {
  return new Map(
    paths.map((file) => {
      const resolved = path.resolve(cwd, file);
      return [resolved, fs.existsSync(resolved) ? fs.readFileSync(resolved) : null];
    }),
  );
}
function restoreVersionFiles(snapshots) {
  for (const [resolved, bytes] of snapshots) {
    if (bytes === null) fs.rmSync(resolved, { force: true });
    else fs.writeFileSync(resolved, bytes);
  }
}

export function localVersionFiles(cwd, intent) {
  const discovered = discoverVersionStateFiles(cwd);
  if (discovered.files.length === 0)
    throw new Error("v4 product publication requires package version state");
  const changedFiles = updateVersionStateContents(discovered.files, intent.version);
  const allowedPaths = versionVerificationAllowedPathsForPromotion(
    intent.channel === "alpha" ? "alpha" : "release",
    discovered.files.map(({ path: filePath }) => filePath),
  );
  const snapshots = snapshotVersionFiles(cwd, allowedPaths);
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
    restoreVersionFiles(snapshots);
  }
}

function withVersionFiles(cwd, files, callback) {
  const snapshots = snapshotVersionFiles(
    cwd,
    files.map(({ path }) => path),
  );
  try {
    for (const file of files) {
      const resolved = path.resolve(cwd, file.path);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, file.content);
    }
    return callback();
  } finally {
    restoreVersionFiles(snapshots);
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
    domainContentRoot("v4-product-required-artifacts", requiredArtifacts) !==
    intent.requiredArtifactsRoot
  )
    throw new Error("required product artifacts drifted from QUALIFY intent");
  const artifactKind = String(intent.artifactKind || "npm").trim();
  const matchingArtifacts = requiredArtifacts.filter(
    ({ kind, required }) => kind === artifactKind && required !== false,
  );
  if (
    artifactKind === "npm" &&
    (intent.npmPackages
      ? matchingArtifacts.length !== intent.npmPackages.length ||
        intent.npmPackages.some(
          (entry) =>
            !matchingArtifacts.some(
              (artifact) =>
                artifact.name === entry.name &&
                artifact.ref === entry.version &&
                artifact.integrity === entry.integrity &&
                artifact.role === entry.role,
            ),
        )
      : matchingArtifacts.length !== 1 || matchingArtifacts[0].name !== intent.packageName)
  )
    throw new Error("v4 product publication currently requires one exact main npm artifact");
  if (artifactKind === "custom" && matchingArtifacts.length === 0)
    throw new Error("v4 custom product publication requires at least one exact required artifact");
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
  if (intent.npmPackages || sealedBundle.npmPackages) {
    if (
      !intent.npmPackages ||
      sealedBundle.npmPackages?.length !== intent.npmPackages.length ||
      intent.npmPackages.some(
        (entry) =>
          !sealedBundle.npmPackages.some(
            (sealed) =>
              entry.name === sealed.name &&
              entry.version === sealed.version &&
              entry.path === sealed.path &&
              entry.role === sealed.role &&
              entry.integrity === sealed.integrity &&
              entry.sha256 === `sha256:${sealed.sha256}`,
          ),
      )
    ) {
      throw new Error("sealed npm package set drifted from QUALIFY intent");
    }
  }
  return sealedBundle;
}

function createPackedPackage(context) {
  let packed;
  return (operation) => {
    if (context.intent.channel === "alpha") {
      const entry = context.intent.npmPackages
        ? context.sealedBundle.npmPackages.find(({ name }) => name === operation.target.packageName)
        : context.sealedBundle.npm;
      if (!entry) throw new Error("rooted npm package operation is absent");
      return { tarballPath: entry.absolutePath, integrity: entry.integrity, sha256: entry.sha256 };
    }
    if (packed) return packed;
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-product-"));
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
      const pack = readNpmPackResult(String(result.stdout || "[]"));
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
  const operation = operationFor(context.plan, effect);
  const expected = packedPackage(operation);
  const delays = context.packageEffectAttempted.has(operation.id)
    ? NPM_POST_PUBLISH_READBACK_DELAYS_MS
    : [0];
  for (const [index, delayMs] of delays.entries()) {
    if (delayMs > 0) await context.wait(delayMs);
    const result = context.spawn(
      "npm",
      [
        "view",
        `${operation.target.packageName}@${operation.target.version}`,
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
    const { integrity } = parseNpmView(result.stdout);
    if (integrity !== expected.integrity) return conflict("npm-integrity-conflict");
    return observed(effect, {
      kind: "npm-package",
      packageName: operation.target.packageName,
      version: context.intent.version,
      integrity,
      sha256: expected.sha256,
    });
  }
  return absent("npm-version-absent");
}

function npmApply(context, packedPackage, effect) {
  const operation = operationFor(context.plan, effect);
  const pack = packedPackage(operation);
  context.packageEffectAttempted.add(operation.id);
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
    ...(context.intent.npmPackages ? { packageName: operation.target.packageName } : {}),
    version: context.intent.version,
    tag: context.intent.distTag,
  });
}

export function createProductPublicationAdapters({
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
    (intent.artifactKind || "npm") === "npm" ? verifyRootedBundle(request, intent) : undefined;
  const context = {
    request,
    intent,
    plan,
    cwd,
    spawn,
    sealedBundle,
    versionFiles: intent.channel === "alpha" ? [] : localVersionFiles(cwd, intent),
    packageEffectAttempted: new Set(),
    wait,
    githubMutation: (operation, readback) => retryGithubMutation(wait, operation, readback),
    updates: [],
  };
  const packedPackage = createPackedPackage(context);
  const github = createGithubProductAdapters(context);
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
      ...(intent.artifactKind === "oci"
        ? {
            "oci-image-family": createOciPublicationAdapter({
              request,
              intent,
              plan,
              token: request.registryToken,
            }),
          }
        : {}),
    },
    updates: context.updates,
    resolveReleaseSha: github.resolveReleaseSha,
    resolvePromotedSha: github.resolvePromotedSha,
  };
}
