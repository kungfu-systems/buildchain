import { parseExpectedArtifactsJson } from "../artifact/expectations.js";
import { validateExpectedArtifacts } from "../artifact/expectations.js";
import { createArtifactSummary } from "../artifact/summary.js";
import { sha256File } from "./files.js";
import { manifestPathFor } from "./files.js";
import { collectArtifactFiles } from "./files.js";
import { signingArtifactPathsForPlatform } from "./files.js";
import { readProcessSummaryArtifact } from "./sampling.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyCompilerCacheActivity } from "../cache/compiler-evidence.js";
import { lifecycleSubstageEvidenceContext } from "../lifecycle/substage-evidence.js";
export function verifyBuildLifecycleCompilerCacheActivity({
  stageName = "",
  executed = false,
  cwd = process.cwd(),
  env = process.env,
  verifier = verifyCompilerCacheActivity,
  frameworkLog,
} = {}) {
  if (stageName !== "build" || !executed) return undefined;
  const activity = verifier({ cwd, env });
  if (activity) {
    frameworkLog?.info("compiler-cache.activity", { attributes: activity });
  }
  return activity;
}

export function readLifecycleSupportArtifacts(context) {
  const shouldReadProcessSummary = Boolean(
    context.resolvedProcessSummaryPath &&
    (fs.existsSync(context.resolvedProcessSummaryPath) ||
      context.processSummaryRequired),
  );
  return {
    processSummaryArtifact: shouldReadProcessSummary
      ? readProcessSummaryArtifact(context.resolvedProcessSummaryPath)
      : undefined,
    sourceCheckoutArtifact: fs.existsSync(context.resolvedSourceCheckoutPath)
      ? JSON.parse(fs.readFileSync(context.resolvedSourceCheckoutPath, "utf8"))
      : undefined,
    compilerCachePreparationArtifact: fs.existsSync(
      context.resolvedCompilerCachePreparationPath,
    )
      ? JSON.parse(
          fs.readFileSync(context.resolvedCompilerCachePreparationPath, "utf8"),
        )
      : undefined,
  };
}

export function collectLifecycleArtifacts(context) {
  const compilerCacheActivity = verifyBuildLifecycleCompilerCacheActivity({
    stageName: context.stageName,
    executed: context.executed,
    cwd: context.resolvedCwd,
    frameworkLog: context.frameworkLog,
    env: context.env,
  });
  const substages = lifecycleSubstageEvidenceContext({
    substageEvidencePath: context.substageEvidencePath,
    cwd: context.resolvedCwd,
    workspace: context.resolvedWorkspace,
    diagnosticsDir: context.diagnosticsDir,
    lifecycleStage: context.stageName,
    platformId: context.platformId,
  });
  const support = readLifecycleSupportArtifacts(context);
  fs.mkdirSync(path.dirname(context.resolvedManifestPath), { recursive: true });
  const scanStartedAt = Date.now();
  const signingArtifactPaths =
    context.stageName === "build"
      ? signingArtifactPathsForPlatform({
          loadedConfig: context.loadedConfig,
          cwd: context.resolvedCwd,
          platformId: context.platformId,
        })
      : [];
  const files = collectArtifactFiles(context.resolvedWorkspace, [
    ...context.artifactPaths,
    ...signingArtifactPaths,
  ]);
  const manifestFiles = files.map((file) => {
    const stat = fs.statSync(file);
    return {
      path: manifestPathFor(context.resolvedWorkspace, file),
      size: stat.size,
      sha256: sha256File(file),
    };
  });
  const artifactScanDurationMs = Date.now() - scanStartedAt;
  context.frameworkLog.info("artifact.scan", {
    durationMs: artifactScanDurationMs,
    attributes: { fileCount: manifestFiles.length },
  });
  const platform = {
    id: context.platformId,
    name: context.platformName,
    os: context.env.RUNNER_OS || os.platform(),
    arch: context.env.RUNNER_ARCH || os.arch(),
  };
  const summary = createArtifactSummary({
    artifactName: context.artifactName,
    platform,
    files: manifestFiles,
  });
  const expectedArtifacts = validateExpectedArtifacts({
    expected: parseExpectedArtifactsJson(context.expectedArtifactsJson),
    files: manifestFiles,
    summary,
  });
  return {
    compilerCacheActivity,
    substages,
    ...support,
    manifestFiles,
    artifactScanDurationMs,
    platform,
    summary,
    expectedArtifacts,
  };
}
