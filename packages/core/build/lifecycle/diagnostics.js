import { sha256File } from "./files.js";
import { toPosix } from "./files.js";
import fs from "node:fs";
import path from "node:path";
import { BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT } from "../../observability/diagnostics.js";
import { createDiagnosticsArtifact } from "../../observability/diagnostics.js";
import { writeDiagnosticsArtifact } from "../../observability/diagnostics.js";
export function writeJsonlEvents(filePath, events = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    events.map((event) => JSON.stringify(event)).join("\n") +
      (events.length ? "\n" : ""),
  );
}

export function copyIfExists(sourcePath, targetPath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return false;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

export function resolveLinkedFilePath({
  linkedPath = "",
  workspace,
  cwd,
  fallbackDir,
}) {
  if (!linkedPath) {
    return "";
  }
  const candidates = path.isAbsolute(linkedPath)
    ? [linkedPath]
    : [
        path.resolve(workspace, linkedPath),
        path.resolve(cwd, linkedPath),
        path.resolve(fallbackDir, linkedPath),
      ];
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) ||
    candidates[0] ||
    ""
  );
}

export function diagnosticsSidecarEntry({
  kind,
  filePath,
  workspace,
  required = false,
}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return null;
  }
  return {
    kind,
    path: toPosix(path.relative(workspace, filePath)),
    bytes: stat.size,
    sha256: sha256File(filePath),
    required: Boolean(required),
  };
}

export function writeDiagnosticsSidecarManifest(
  filePath,
  {
    workspace,
    artifactName,
    platformId,
    diagnosticsArtifactName = "",
    files = [],
  },
) {
  const entries = files
    .map((entry) => diagnosticsSidecarEntry({ ...entry, workspace }))
    .filter(Boolean);
  const manifest = {
    schemaVersion: 1,
    contract: BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT,
    generatedAt: new Date().toISOString(),
    artifactName,
    platformId,
    ...(diagnosticsArtifactName ? { diagnosticsArtifactName } : {}),
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    files: entries,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function diagnosticsLinks(context, artifacts) {
  const {
    processSummaryArtifact,
    sourceCheckoutArtifact,
    compilerCachePreparationArtifact,
    substages,
  } = artifacts;
  return {
    artifactName: context.artifactName,
    platformId: context.platformId,
    ...(context.manifestArtifactName
      ? { manifestArtifactName: context.manifestArtifactName }
      : {}),
    ...(context.diagnosticsArtifactName
      ? { diagnosticsArtifactName: context.diagnosticsArtifactName }
      : {}),
    manifest: toPosix(
      path.relative(context.resolvedWorkspace, context.resolvedManifestPath),
    ),
    summary: toPosix(
      path.relative(context.resolvedWorkspace, context.resolvedSummaryPath),
    ),
    log: context.relativeLogPath,
    diagnosticsManifest: context.relativeDiagnosticsManifestPath,
    diagnosticsEvents: context.relativeDiagnosticsEventsPath,
    ...(context.relativeProcessSummaryPath
      ? { processSummary: context.relativeProcessSummaryPath }
      : {}),
    ...(processSummaryArtifact
      ? {
          diagnosticsProcessSummary:
            context.relativeDiagnosticsProcessSummaryPath,
        }
      : {}),
    ...(processSummaryArtifact?.samplesPath
      ? {
          diagnosticsProcessSamples:
            context.relativeDiagnosticsProcessSamplesPath,
        }
      : {}),
    ...substages.links,
    ...(sourceCheckoutArtifact
      ? { sourceCheckout: context.relativeDiagnosticsSourceCheckoutPath }
      : {}),
    ...(compilerCachePreparationArtifact
      ? {
          compilerCachePreparation:
            context.relativeDiagnosticsCompilerCachePreparationPath,
        }
      : {}),
  };
}

export function persistLifecycleDiagnostics(context, artifacts, product) {
  fs.writeFileSync(
    context.resolvedManifestPath,
    `${JSON.stringify(product.manifest, null, 2)}\n`,
  );
  fs.mkdirSync(path.dirname(context.resolvedSummaryPath), { recursive: true });
  fs.writeFileSync(
    context.resolvedSummaryPath,
    `${JSON.stringify(product.summaryWithObservability, null, 2)}\n`,
  );
  writeDiagnosticsArtifact(
    context.resolvedDiagnosticsPath,
    createDiagnosticsArtifact({
      cwd: context.resolvedCwd,
      logPath: context.resolvedLogPath,
      artifactPaths: context.artifactPaths,
      lifecycleObservability: product.lifecycleObservability,
      processSummary: artifacts.processSummaryArtifact?.summary,
      sourceCheckout: artifacts.sourceCheckoutArtifact,
      compilerCachePreparation: artifacts.compilerCachePreparationArtifact,
      links: diagnosticsLinks(context, artifacts),
    }),
  );
  if (context.resolvedLogPath && fs.existsSync(context.resolvedLogPath)) {
    copyIfExists(
      context.resolvedLogPath,
      context.resolvedDiagnosticsEventsPath,
    );
  } else {
    writeJsonlEvents(context.resolvedDiagnosticsEventsPath, [
      ...context.frameworkLog.events,
      ...context.userLog.events,
    ]);
  }
  if (artifacts.processSummaryArtifact) {
    copyIfExists(
      context.resolvedProcessSummaryPath,
      context.resolvedDiagnosticsProcessSummaryPath,
    );
    const resolvedSamplesPath = resolveLinkedFilePath({
      linkedPath: artifacts.processSummaryArtifact.samplesPath,
      workspace: context.resolvedWorkspace,
      cwd: context.resolvedCwd,
      fallbackDir: path.dirname(context.resolvedProcessSummaryPath),
    });
    copyIfExists(
      resolvedSamplesPath,
      context.resolvedDiagnosticsProcessSamplesPath,
    );
  }
  copyIfExists(artifacts.substages.sourcePath, artifacts.substages.targetPath);
  if (artifacts.sourceCheckoutArtifact) {
    copyIfExists(
      context.resolvedSourceCheckoutPath,
      context.resolvedDiagnosticsSourceCheckoutPath,
    );
  }
  if (artifacts.compilerCachePreparationArtifact) {
    copyIfExists(
      context.resolvedCompilerCachePreparationPath,
      context.resolvedDiagnosticsCompilerCachePreparationPath,
    );
  }
  writeDiagnosticsSidecarManifest(context.resolvedDiagnosticsManifestPath, {
    workspace: context.resolvedWorkspace,
    artifactName: context.artifactName,
    platformId: context.platformId,
    diagnosticsArtifactName: context.diagnosticsArtifactName,
    files: [
      {
        kind: "diagnostics",
        filePath: context.resolvedDiagnosticsPath,
        required: true,
      },
      {
        kind: "events",
        filePath: context.resolvedDiagnosticsEventsPath,
        required: true,
      },
      {
        kind: "process-summary",
        filePath: context.resolvedDiagnosticsProcessSummaryPath,
      },
      {
        kind: "process-samples",
        filePath: context.resolvedDiagnosticsProcessSamplesPath,
      },
      artifacts.substages.sidecar,
      {
        kind: "source-checkout",
        filePath: context.resolvedDiagnosticsSourceCheckoutPath,
      },
      {
        kind: "compiler-cache-preparation",
        filePath: context.resolvedDiagnosticsCompilerCachePreparationPath,
      },
    ],
  });
  console.log(
    `buildchain_manifest=${path.relative(context.resolvedWorkspace, context.resolvedManifestPath)}`,
  );
  return product.manifest;
}
