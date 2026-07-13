#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createReleaseCandidatePassport,
  validateReleaseCandidatePassport,
} from "../packages/core/release-candidate.js";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function generateReleaseCandidatePassportCli() {
  const buildSummaryPath = path.resolve(env("BUILDCHAIN_BUILD_SUMMARY_PATH", ".buildchain/artifacts/build-summary.json"));
  const outputPath = path.resolve(env("BUILDCHAIN_RC_PASSPORT_PATH", ".buildchain/artifacts/release-candidate-passport.json"));
  const buildSummary = readJsonFile(buildSummaryPath);
  const sourceSha = env("BUILDCHAIN_RC_SOURCE_HEAD_SHA", buildSummary.publishSource?.sha || buildSummary.git?.sha || "");
  const version = env(
    "BUILDCHAIN_RC_VERSION",
    buildSummary.publishSource?.consumerVersion || "",
  );
  const gateAggregateJson = env("BUILDCHAIN_GATE_PROFILE_AGGREGATE_JSON");
  const gateAggregate = gateAggregateJson ? JSON.parse(gateAggregateJson) : undefined;
  const passport = createReleaseCandidatePassport({
    repository: env("GITHUB_REPOSITORY", buildSummary.git?.repository || ""),
    pullRequest: {
      number: env("BUILDCHAIN_PULL_REQUEST_NUMBER"),
      url: env("BUILDCHAIN_PULL_REQUEST_URL"),
      headRef: env("BUILDCHAIN_PULL_REQUEST_HEAD_REF"),
      baseRef: env("BUILDCHAIN_PULL_REQUEST_BASE_REF"),
    },
    targetChannel: env("BUILDCHAIN_RC_TARGET_CHANNEL", buildSummary.publishSource?.channel || buildSummary.publishGate?.channel || ""),
    version,
    sourceHeadSha: sourceSha,
    baseSha: env("BUILDCHAIN_RC_BASE_SHA"),
    mergeRefSha: env("BUILDCHAIN_RC_MERGE_REF_SHA", buildSummary.git?.sha || ""),
    sourceTreeHash: env("BUILDCHAIN_RC_SOURCE_TREE_HASH"),
    buildSummary,
    buildchain: {
      ref: env("BUILDCHAIN_RUNTIME_REF", buildSummary.runtime?.ref || ""),
      sha: env("BUILDCHAIN_RUNTIME_SHA", buildSummary.runtime?.sha || ""),
      version: env("BUILDCHAIN_RUNTIME_VERSION"),
      workflowShellRef: env("BUILDCHAIN_WORKFLOW_SHELL_REF", buildSummary.runtime?.workflowShellRef || ""),
    },
    gateAggregate,
    workflow: {
      name: env("GITHUB_WORKFLOW"),
      runId: env("GITHUB_RUN_ID", buildSummary.git?.runId || ""),
      runAttempt: env("GITHUB_RUN_ATTEMPT", buildSummary.git?.runAttempt || ""),
      url: env("BUILDCHAIN_WORKFLOW_RUN_URL"),
    },
  });
  const validation = validateReleaseCandidatePassport({
    passport,
    repository: env("GITHUB_REPOSITORY", buildSummary.git?.repository || ""),
    sourceHeadSha: sourceSha,
    buildSummary,
  });
  if (!validation.ok) {
    throw new Error(`release candidate passport invalid: ${validation.errors.join("; ")}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(passport, null, 2)}\n`);
  writeGitHubOutputs({
    "release-candidate-passport-path": path.relative(process.cwd(), outputPath).split(path.sep).join("/"),
    "release-candidate-passport-json": JSON.stringify({
      contract: passport.contract,
      repository: passport.repository,
      target: passport.target,
      source: passport.source,
      candidateHash: passport.candidateHash,
      platformCount: passport.platformMatrix.length,
      gateProfileEvidence: passport.gateProfileEvidence,
    }),
  });
  return passport;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    generateReleaseCandidatePassportCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
