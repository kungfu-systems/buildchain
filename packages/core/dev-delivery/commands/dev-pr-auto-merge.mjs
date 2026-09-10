#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { normalizeOptions, DEFAULT_READY_LABEL } from "../admission/policy.js";
import { runDevPrAdmission, renderAdmissionComment } from "../admission/targeted.js";
import { runDevPrAutoMerge } from "../admission/queue.js";
import { renderMarkdownSummary } from "../admission/report.js";
export function writeGitHubOutputs(outputs, outputFile = process.env.GITHUB_OUTPUT) {
  if (!outputFile) return;
  const lines = [];
  for (const [key, value] of Object.entries(outputs)) {
    lines.push(`${key}=${String(value).replace(/\n/g, "%0A")}`);
  }
  fs.appendFileSync(outputFile, `${lines.join("\n")}\n`);
}

function cliValue(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function cliFlag(args, name) {
  return args.includes(`--${name}`);
}

export function cliOptions(args = [], environment = process.env) {
  const targetPullRequestNumber = cliValue(args, "pull-request", environment.BUILDCHAIN_DEV_PR_EXPECTED_PR_NUMBER);
  const warrantMode = cliValue(
    args,
    "warrant-mode",
    environment.BUILDCHAIN_DEV_PR_WARRANT_MODE || environment.WARRANT_MODE,
  );
  return {
    repository: cliValue(args, "repository", environment.BUILDCHAIN_DEV_PR_REPOSITORY || environment.GITHUB_REPOSITORY),
    targetBranch: cliValue(args, "branch", environment.BUILDCHAIN_DEV_PR_TARGET_BRANCH || environment.GITHUB_REF_NAME),
    targetPullRequestNumber,
    expectedHeadSha: cliValue(args, "expected-head", environment.BUILDCHAIN_DEV_PR_EXPECTED_HEAD_SHA),
    readyLabel: cliValue(args, "ready-label", environment.BUILDCHAIN_DEV_PR_READY_LABEL || DEFAULT_READY_LABEL),
    blockLabels: cliValue(args, "block-labels", environment.BUILDCHAIN_DEV_PR_BLOCK_LABELS),
    allowedHeadPrefixes: cliValue(args, "allowed-head-prefixes", environment.BUILDCHAIN_DEV_PR_ALLOWED_HEAD_PREFIXES),
    requiredChecks: cliValue(args, "required-checks", environment.BUILDCHAIN_DEV_PR_REQUIRED_CHECKS),
    queueAdmissionContext: cliValue(
      args,
      "queue-admission-context",
      environment.BUILDCHAIN_DEV_PR_QUEUE_ADMISSION_CONTEXT || (warrantMode === "required" ? "Queue admission lease" : ""),
    ),
    activeLeaseContext: cliValue(args, "active-lease-context", environment.BUILDCHAIN_DEV_PR_ACTIVE_LEASE_CONTEXT),
    diagnosticContext: cliValue(args, "diagnostic-context", environment.BUILDCHAIN_DEV_PR_DIAGNOSTIC_CONTEXT),
    warrantMode,
    warrantResultPath: cliValue(args, "warrant-result", environment.BUILDCHAIN_DEV_PR_WARRANT_RESULT_PATH),
    projectCutProofPath: cliValue(args, "project-cut-proof", environment.BUILDCHAIN_DEV_PR_PROJECT_CUT_PROOF_PATH),
    sourceProofPath: cliValue(args, "source-proof", environment.BUILDCHAIN_DEV_PR_SOURCE_PROOF_PATH),
    sourcePatchRoot: cliValue(args, "source-patch-root", environment.BUILDCHAIN_DEV_PR_SOURCE_PATCH_ROOT),
    qualificationOnly: cliFlag(args, "qualification-only"),
    requireApproval: environment.BUILDCHAIN_DEV_PR_REQUIRE_APPROVAL,
    sameRepositoryOnly: environment.BUILDCHAIN_DEV_PR_SAME_REPOSITORY_ONLY,
    maxMerges: environment.BUILDCHAIN_DEV_PR_MAX_MERGES,
    mergeMethod: environment.BUILDCHAIN_DEV_PR_MERGE_METHOD,
    landingMode: cliValue(args, "landing-mode", environment.BUILDCHAIN_DEV_PR_LANDING_MODE),
    dryRun: cliFlag(args, "execute") ? false : environment.BUILDCHAIN_DEV_PR_DRY_RUN,
    outputPath: cliValue(
      args,
      "output",
      environment.BUILDCHAIN_DEV_PR_OUTPUT_PATH || (targetPullRequestNumber
        ? ".buildchain/dev-pr-admission/result.json"
        : ".buildchain/dev-pr-auto-merge/result.json"),
    ),
    useGhCli: cliFlag(args, "gh-cli"),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (cliFlag(args, "help")) {
    process.stdout.write("Usage:\n  buildchain dev pr-admit --repository owner/repo --branch dev/vN/vN.M --pull-request N --expected-head SHA [--qualification-only] [--landing-mode auto|direct|queue] [--warrant-mode off|required] [--warrant-result FILE] [--execute] [--output FILE] [--json]\n");
    return;
  }
  const options = normalizeOptions(cliOptions(args));
  const connection = { token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL };
  const targeted = options.targetPullRequestNumber > 0 || Boolean(options.expectedHeadSha);
  const result = targeted
    ? await runDevPrAdmission({ ...options, ...connection, useGhCli: cliFlag(args, "gh-cli") || !connection.token })
    : await runDevPrAutoMerge({ ...options, ...connection });
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  const summary = targeted ? `${renderAdmissionComment(result.receipt, result.receiptRoot)}\n` : renderMarkdownSummary(result);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else if (cliFlag(args, "json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(summary);
  writeGitHubOutputs({
    "evaluated-count": targeted ? 1 : result.evaluated.length,
    "merged-count": targeted ? Number(result.receipt.state === "merged") : result.merged.length,
    "enqueued-count": targeted ? Number(result.receipt.state === "queued") : result.enqueued.length,
    "action-count": targeted ? Number(result.ok) : result.actions.length,
    "skipped-count": targeted ? Number(!result.ok) : result.skipped.length,
    "final-base-sha": targeted ? "" : result.finalBaseSha,
    "targeted": targeted,
    "targeted-ok": targeted ? result.ok : "",
    "admission-state": targeted ? result.receipt.state : "",
    "receipt-root": targeted ? result.receiptRoot : "",
    "result-path": options.outputPath,
  });
  if (targeted && !result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
