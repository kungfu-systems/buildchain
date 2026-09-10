#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { sourceQualificationPredicates } from "../source-proof/predicates.js";
import { sealSourceQualificationProof } from "../source-proof/seal.js";
import { verifySourceQualificationReuse, rootedDecision, REUSE_DECISION_SCHEMA } from "../source-proof/reuse.js";
import { materializeReuseLifecycleEvidence } from "../source-proof/evidence.js";
import { writeJson } from "../source-proof/io.js";
function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function writeOutputs(values) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  fs.appendFileSync(
    output,
    Object.entries(values)
      .map(([key, value]) => `${key}=${String(value)}\n`)
      .join(""),
  );
}

function cliInput(args) {
  return {
    cwd: flag(args, "cwd", process.cwd()),
    repository: flag(args, "repository", process.env.GITHUB_REPOSITORY),
    protectedBase: flag(args, "branch", process.env.GITHUB_BASE_REF),
    qualifiedBase: flag(args, "qualified-base"),
    currentBase: flag(args, "current-base"),
    sourceHead: flag(args, "source-head"),
    sourceWorkflowRunId: flag(
      args,
      "source-workflow-run-id",
      process.env.GITHUB_RUN_ID,
    ),
    runtimeRef: flag(args, "runtime-ref"),
    runtimeSha: flag(args, "runtime-sha"),
    contractDigest: flag(args, "contract-digest"),
    nodeVersion: flag(args, "node-version", "24"),
    workingDirectory: flag(args, "working-directory", "."),
    policyPaths: flag(args, "policy-paths-json"),
    closurePaths: flag(args, "closure-paths-json"),
    dependencyPaths: flag(args, "dependency-paths-json"),
    requiredContexts: flag(args, "required-contexts-json"),
    controllerReceiptPath: flag(args, "controller-receipt"),
    sourceProofPath: flag(args, "source-proof"),
    mergeGroupHead: flag(args, "merge-group-head"),
    mergeGroupTree: flag(args, "merge-group-tree"),
    qualifiedAt: flag(args, "qualified-at"),
    verifiedAt: flag(args, "verified-at"),
    outputPath: flag(args, "output"),
    manifestPath: flag(args, "manifest-output"),
    summaryPath: flag(args, "summary-output"),
  };
}

export function sourceProofReuseCli(args = process.argv.slice(2)) {
  const [command = "", ...rest] = args;
  const input = cliInput(rest);
  if (command === "predicates") return sourceQualificationPredicates(input);
  if (command === "seal") {
    const proof = sealSourceQualificationProof(input);
    writeJson(input.outputPath, proof);
    writeOutputs({ "proof-root": proof.proofRoot, "proof-reused": "false" });
    return proof;
  }
  if (command === "verify") {
    let decision;
    try {
      decision = verifySourceQualificationReuse(input);
    } catch (error) {
      decision = rootedDecision({
        schema: REUSE_DECISION_SCHEMA,
        reusable: false,
        action: "rerun-full-source-qualification",
        reason: "unverifiable-proof",
        diagnostic: String(error.message || error),
      });
    }
    writeJson(input.outputPath, decision);
    if (decision.reusable && input.manifestPath && input.summaryPath) {
      materializeReuseLifecycleEvidence({
        decision,
        sourceProofPath: input.sourceProofPath,
        decisionPath: input.outputPath,
        manifestPath: input.manifestPath,
        summaryPath: input.summaryPath,
        workspace: input.cwd,
        repository: input.repository,
        sourceRef: process.env.GITHUB_REF,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        platformId: process.env.RUNNER_OS || process.platform,
        platformName:
          process.env.RUNNER_NAME || process.env.RUNNER_OS || process.platform,
        runnerOs: process.env.RUNNER_OS || process.platform,
        runnerArch: process.env.RUNNER_ARCH || process.arch,
      });
    }
    writeOutputs({
      reuse: String(decision.reusable),
      "proof-root": decision.sourceProofRoot || "",
      reason: decision.reason,
      "decision-root": decision.decisionRoot,
    });
    return decision;
  }
  throw new Error(
    "usage: dev-delivery-source-proof-reuse.mjs <predicates|seal|verify> [options]",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = sourceProofReuseCli();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(
      `::error::${String(error.message || error).replace(/\r?\n/gu, "%0A")}`,
    );
    process.exitCode = 1;
  }
}
