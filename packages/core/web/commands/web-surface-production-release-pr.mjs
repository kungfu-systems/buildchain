#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { compactProductionReleasePrSummary } from "../release-pr-summary.js";
import { reconcileProductionReleasePr, productionReleasePrOutputs } from "../release-pr-transaction.js";
function requiredString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optionalString(value = "") {
  return String(value || "").trim();
}

function parseJson(value, name) {
  const normalized = optionalString(value);
  if (!normalized) return {};
  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

function parseBoolean(value, defaultValue = false) {
  const normalized = optionalString(value).toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`expected boolean value, got: ${value}`);
}

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] || "";
}

function readJsonFile(filePath, name) {
  const normalized = requiredString(filePath, name);
  try {
    return JSON.parse(fs.readFileSync(path.resolve(normalized), "utf8"));
  } catch (error) {
    throw new Error(`${name} must point to valid JSON: ${error.message}`);
  }
}

function writeJsonFile(filePath, value) {
  const resolved = path.resolve(requiredString(filePath, "output"));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

export function readStagingReleasePrSummary(env = process.env) {
  const summaryPath = optionalString(env.STAGING_RELEASE_PR_SUMMARY_PATH);
  if (summaryPath) {
    return compactProductionReleasePrSummary(readJsonFile(summaryPath, "STAGING_RELEASE_PR_SUMMARY_PATH"));
  }
  const resultPath = optionalString(env.STAGING_APPLY_RESULT_PATH);
  if (resultPath) {
    return compactProductionReleasePrSummary(readJsonFile(resultPath, "STAGING_APPLY_RESULT_PATH"));
  }
  return compactProductionReleasePrSummary(parseJson(env.STAGING_APPLY_RESULT_JSON, "STAGING_APPLY_RESULT_JSON"));
}

function writeGitHubOutputs(env, outputs) {
  for (const [name, value] of Object.entries(outputs)) {
    const normalized = String(value ?? "");
    console.log(`${name}=${normalized}`);
    if (env.GITHUB_OUTPUT) {
      fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${normalized}\n`);
    }
  }
}

export async function webSurfaceProductionReleasePrCli(env = process.env) {
  const result = await reconcileProductionReleasePr({
    stagingResult: readStagingReleasePrSummary(env), sourceSha: env.GITHUB_SHA, repository: env.GITHUB_REPOSITORY,
    mode: env.PRODUCTION_RELEASE_PR_MODE || "auto", failOnError: parseBoolean(env.FAIL_ON_RELEASE_PR_ERROR),
    productionReleaseLabel: env.PRODUCTION_RELEASE_LABEL || "buildchain-release",
    productionReleaseHeadPrefix: env.PRODUCTION_RELEASE_HEAD_PREFIX || "release/",
    productionReleaseChannel: env.PRODUCTION_RELEASE_CHANNEL || "production",
    runId: env.GITHUB_RUN_ID, serverUrl: env.GITHUB_SERVER_URL || "https://github.com",
    releasePassportArtifact: env.RELEASE_PASSPORT_ARTIFACT || "buildchain-web-surface-staging-release-passport",
    bodyPath: env.PRODUCTION_RELEASE_PR_BODY_PATH || ".buildchain/production-release-pr/body.md",
    summaryPath: env.PRODUCTION_RELEASE_PR_SUMMARY_PATH || ".buildchain/production-release-pr/handoff.json",
    stepSummaryPath: env.GITHUB_STEP_SUMMARY,
    logPath: env.BUILDCHAIN_LOG_PATH || (env.GITHUB_ACTIONS === "true" ? ".buildchain/logs/events.jsonl" : false),
    token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    credential: {
      source: env.PRODUCTION_RELEASE_TOKEN_SOURCE === "github-app" ? "app" : env.PRODUCTION_RELEASE_TOKEN_SOURCE === "production-release-pr-token" ? "fallback" : "workflow",
      appStatus: env.PRODUCTION_RELEASE_APP_TOKEN_STATUS || "not-configured",
      appUnavailable: parseBoolean(env.PRODUCTION_RELEASE_APP_TOKEN_UNAVAILABLE),
      clientConfigured: parseBoolean(env.PRODUCTION_RELEASE_APP_CLIENT_ID_CONFIGURED),
      privateKeyConfigured: parseBoolean(env.PRODUCTION_RELEASE_APP_PRIVATE_KEY_CONFIGURED),
      fallbackConfigured: parseBoolean(env.PRODUCTION_RELEASE_PR_TOKEN_CONFIGURED),
    },
  });
  writeGitHubOutputs(env, productionReleasePrOutputs(result));
  return result;
}

export function writeProductionReleasePrSummaryCli(env = process.env) {
  const input = readArg("input", env.STAGING_APPLY_RESULT_PATH || "");
  const output = readArg("output", env.STAGING_RELEASE_PR_SUMMARY_PATH || "");
  const result = input
    ? readJsonFile(input, "input")
    : parseJson(env.STAGING_APPLY_RESULT_JSON, "STAGING_APPLY_RESULT_JSON");
  const summary = compactProductionReleasePrSummary(result);
  writeJsonFile(output, summary);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (process.argv[2] === "write-summary") {
      writeProductionReleasePrSummaryCli();
    } else {
      await webSurfaceProductionReleasePrCli();
    }
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
