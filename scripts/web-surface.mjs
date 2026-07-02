#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyWebSurfaceCleanup,
  applyWebSurfaceDeploy,
  defaultWebSurfaceAlias,
  planWebSurfaceCleanup,
  planWebSurfaceDeploy,
  validateWebSurfaceProject,
} from "./web-surface-core.mjs";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || "";
}

function readBooleanArg(name, fallback = true) {
  const value = readArg(name, "");
  if (!value) {
    return fallback;
  }
  return value === "true" || value === "1";
}

function writeJson(result, outputPath) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, json);
  } else {
    process.stdout.write(json);
  }
}

function readJsonFileArg(name) {
  const value = readArg(name, "");
  if (!value) {
    return null;
  }
  return JSON.parse(fs.readFileSync(path.resolve(value), "utf8"));
}

function assertApplySucceeded(result) {
  if (result.status === "failed") {
    throw new Error(`web-surface ${result.contract} failed; see apply result for operation details`);
  }
}

export function webSurfaceCli() {
  const mode = readArg("mode", process.env.BUILDCHAIN_WEB_SURFACE_MODE || "validate");
  const cwd = readArg("cwd", process.env.BUILDCHAIN_WORKDIR || process.cwd());
  const channel = readArg("channel", process.env.BUILDCHAIN_WEB_SURFACE_CHANNEL || "preview");
  const sourceSha = readArg("source-sha", process.env.BUILDCHAIN_SOURCE_SHA || process.env.GITHUB_SHA || "");
  const pullNumber = readArg("pull-number", process.env.BUILDCHAIN_PULL_NUMBER || "");
  const output = readArg("output", process.env.BUILDCHAIN_WEB_SURFACE_OUTPUT || "");

  if (mode === "validate") {
    const result = validateWebSurfaceProject(cwd);
    writeJson(result, output);
    writeGitHubOutputs({
      "project-type": result.project?.type || "",
      "web-surface-site": result.project?.site || result.project?.name || "",
    });
    return result;
  }

  if (mode === "deploy-plan" || mode === "manifest") {
    const alias = readArg(
      "alias",
      process.env.BUILDCHAIN_WEB_SURFACE_ALIAS || defaultWebSurfaceAlias({ channel, sourceSha, pullNumber }),
    );
    const result = planWebSurfaceDeploy({
      cwd,
      channel,
      alias,
      sourceSha,
      artifactHash: readArg("artifact-hash", process.env.BUILDCHAIN_WEB_SURFACE_ARTIFACT_HASH || ""),
      artifactPath: readArg("artifact-path", process.env.BUILDCHAIN_WEB_SURFACE_ARTIFACT_PATH || ""),
      dryRun: readBooleanArg("dry-run", true),
    });
    const outputResult = mode === "manifest" ? result.manifest : result;
    writeJson(outputResult, output);
    writeGitHubOutputs({
      "web-surface-channel": result.channel,
      "web-surface-alias": result.alias,
      "web-surface-url": result.url,
      "web-surface-urls-json": JSON.stringify(result.urls || {}),
      "web-surface-artifact-hash": result.artifact.hash,
      "web-surface-manifest-json": JSON.stringify(result.manifest),
    });
    return outputResult;
  }

  if (mode === "deploy-apply") {
    const plan = readJsonFileArg("plan");
    const alias = plan
      ? readArg("alias", process.env.BUILDCHAIN_WEB_SURFACE_ALIAS || "")
      : readArg(
          "alias",
          process.env.BUILDCHAIN_WEB_SURFACE_ALIAS || defaultWebSurfaceAlias({ channel, sourceSha, pullNumber }),
        );
    const result = applyWebSurfaceDeploy({
      cwd,
      channel,
      alias,
      sourceSha,
      artifactHash: readArg("artifact-hash", process.env.BUILDCHAIN_WEB_SURFACE_ARTIFACT_HASH || ""),
      artifactPath: readArg("artifact-path", process.env.BUILDCHAIN_WEB_SURFACE_ARTIFACT_PATH || ""),
      plan,
      dryRun: readBooleanArg("dry-run", true),
      actor: readArg("actor", process.env.GITHUB_ACTOR || ""),
      runId: readArg("run-id", process.env.GITHUB_RUN_ID || ""),
    });
    writeJson(result, output);
    writeGitHubOutputs({
      "web-surface-channel": result.channel,
      "web-surface-alias": result.alias,
      "web-surface-url": result.url,
      "web-surface-urls-json": JSON.stringify(result.urls || {}),
      "web-surface-artifact-hash": result.artifactHash,
      "web-surface-apply-mode": result.applyMode,
      "web-surface-apply-status": result.status,
      "web-surface-manifest-json": JSON.stringify(result.manifest),
      "web-surface-bindings-json": JSON.stringify(result.surfaceBindings || []),
      "web-surface-apply-result-json": JSON.stringify(result),
    });
    assertApplySucceeded(result);
    return result;
  }

  if (mode === "cleanup-plan") {
    const aliases = readArg("aliases", process.env.BUILDCHAIN_WEB_SURFACE_ALIASES || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const result = planWebSurfaceCleanup({
      cwd,
      channel,
      aliases,
      sourceSha,
      pullNumber,
      event: readArg("event", process.env.BUILDCHAIN_WEB_SURFACE_EVENT || "manual"),
      actor: readArg("actor", process.env.GITHUB_ACTOR || ""),
      runId: readArg("run-id", process.env.GITHUB_RUN_ID || ""),
      dryRun: readBooleanArg("dry-run", true),
    });
    writeJson(result, output);
    writeGitHubOutputs({
      "web-surface-cleanup-count": String(result.entries.length),
      "web-surface-cleanup-mode": result.applyMode,
      "web-surface-cleanup-status": result.status,
      "web-surface-cleanup-plan-json": JSON.stringify(result),
    });
    return result;
  }

  if (mode === "cleanup-apply") {
    const plan = readJsonFileArg("plan");
    const aliases = readArg("aliases", process.env.BUILDCHAIN_WEB_SURFACE_ALIASES || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const result = applyWebSurfaceCleanup({
      cwd,
      channel,
      aliases,
      sourceSha,
      pullNumber,
      event: readArg("event", process.env.BUILDCHAIN_WEB_SURFACE_EVENT || "manual"),
      actor: readArg("actor", process.env.GITHUB_ACTOR || ""),
      runId: readArg("run-id", process.env.GITHUB_RUN_ID || ""),
      plan,
      dryRun: readBooleanArg("dry-run", true),
    });
    writeJson(result, output);
    writeGitHubOutputs({
      "web-surface-cleanup-count": String(result.entries.length),
      "web-surface-cleanup-mode": result.applyMode,
      "web-surface-cleanup-status": result.status,
      "web-surface-cleanup-result-json": JSON.stringify(result),
    });
    assertApplySucceeded(result);
    return result;
  }

  throw new Error(`unsupported web-surface mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    webSurfaceCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
