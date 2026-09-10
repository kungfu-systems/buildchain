import fs from "node:fs";
import path from "node:path";

export function writeJson(result, outputPath) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, json);
  } else {
    process.stdout.write(json);
  }
}

export function assertApplySucceeded(result) {
  if (result.status === "failed") {
    printApplyFailureSummary(result);
    throw new Error(
      `web-surface ${result.contract} failed; see apply result for operation details`,
    );
  }
}

export function operationFailureSummary(result) {
  const failed = (result.operations || []).find(
    (operation) => operation.status === "failed",
  );
  if (!failed) {
    return "";
  }
  const stderr = String(failed.stderr || "").trim();
  const stdout = String(failed.stdout || "").trim();
  return [
    `web-surface failed operation: ${failed.action || "unknown"}`,
    `surface: ${failed.surface || "unknown"}`,
    failed.command
      ? `command: ${failed.command} ${(failed.args || []).join(" ")}`
      : "",
    failed.exitCode !== null && failed.exitCode !== undefined
      ? `exitCode: ${failed.exitCode}`
      : "",
    stderr ? `stderr: ${stderr}` : "",
    stdout ? `stdout: ${stdout}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function printApplyFailureSummary(result) {
  const summary = operationFailureSummary(result);
  if (summary) {
    console.error(summary);
  }
}

export function writeFailureResult({ output, mode, cwd, error }) {
  if (!output) {
    return null;
  }
  const resolvedOutput = path.resolve(output);
  if (fs.existsSync(resolvedOutput)) {
    return JSON.parse(fs.readFileSync(resolvedOutput, "utf8"));
  }
  const result = {
    schemaVersion: 1,
    contract:
      mode === "cleanup-apply"
        ? "kungfu-buildchain-web-surface-cleanup-apply"
        : "kungfu-buildchain-web-surface-deploy-apply",
    status: "failed",
    error: {
      message: String(error?.message || error),
    },
    cwd,
    generatedAt: new Date().toISOString(),
  };
  writeJson(result, resolvedOutput);
  return result;
}

export function compactWebSurfaceApplyResult(result = {}) {
  const manifest =
    result.manifest && typeof result.manifest === "object"
      ? result.manifest
      : {};
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-deploy-apply-summary",
    sourceContract: result.contract || "",
    channel: result.channel || manifest.channel || "",
    alias: result.alias || manifest.alias || "",
    applyMode: result.applyMode || "",
    status: result.status || "",
    actor: result.actor || "",
    runId: result.runId || "",
    appliedAt: result.appliedAt || "",
    url: result.url || "",
    urls: result.urls && typeof result.urls === "object" ? result.urls : {},
    sourceSha: result.sourceSha || manifest.sourceSha || "",
    artifactHash: result.artifactHash || manifest.artifactHash || "",
    adapter: result.adapter || "",
    target: result.target || "",
    objectPrefix: result.objectPrefix || "",
    manifestKey: result.manifestKey || "",
    ...compactSurfaceEffects(result),
  };
}

function compactSurfaceBinding(binding) {
  return {
    surface: binding.surface || "",
    pathPrefix: binding.pathPrefix || "",
    objectPrefix: binding.objectPrefix || "",
    url: binding.url || "",
    manifestKey: binding.manifestKey || "",
    accessControl: binding.accessControl || "",
    healthStrategy: binding.healthStrategy || "",
    mutableDeleteExcludes: binding.mutableDeleteExcludes || [],
    observedEvidenceOwnership: binding.observedEvidenceOwnership || null,
  };
}

function compactSurfaceEffects(result) {
  return {
    invalidationPaths: Array.isArray(result.invalidationPaths)
      ? result.invalidationPaths
      : [],
    immutablePreservation: Array.isArray(result.immutablePreservation)
      ? result.immutablePreservation
      : [],
    surfaceBindings: Array.isArray(result.surfaceBindings)
      ? result.surfaceBindings.map(compactSurfaceBinding)
      : [],
  };
}
