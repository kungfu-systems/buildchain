import fs from "node:fs";
import path from "node:path";
import { compactProductionReleasePrSummary } from "./release-pr-summary.js";
import {
  reconcileProductionReleasePr,
  productionReleasePrOutputs,
} from "./release-pr-transaction.js";

export async function reconcileWebReleasePrAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const local = (file) => path.join(env.GITHUB_WORKSPACE, ".buildchain", file);
  const result = await reconcileProductionReleasePr({
    stagingResult: compactProductionReleasePrSummary(
      JSON.parse(
        fs.readFileSync(
          local(
            "staging-release-pr-summary/web-surface-staging-release-pr-summary.json",
          ),
          "utf8",
        ),
      ),
    ),
    sourceSha: env.GITHUB_SHA,
    repository: env.GITHUB_REPOSITORY,
    mode: request["production-release-pr-mode"] || "auto",
    failOnError: request["fail-on-release-pr-error"] ?? false,
    productionReleaseLabel:
      request["production-release-label"] || "buildchain-release",
    productionReleaseHeadPrefix:
      request["production-release-head-prefix"] || "release/",
    productionReleaseChannel:
      request["production-release-branch-channel"] || "production",
    runId: env.GITHUB_RUN_ID,
    serverUrl: env.GITHUB_SERVER_URL,
    bodyPath: local("production-release-pr/body.md"),
    summaryPath: local("production-release-pr/handoff.json"),
    stepSummaryPath: env.GITHUB_STEP_SUMMARY,
    logPath: local("logs/events.jsonl"),
    token: core.getInput("token"),
    apiUrl: env.GITHUB_API_URL,
    credential: JSON.parse(
      core.getInput("credential-json", { required: true }),
    ),
  });
  for (const [key, value] of Object.entries(productionReleasePrOutputs(result)))
    core.setOutput(key, value);
}
