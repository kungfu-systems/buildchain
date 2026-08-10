#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { classifyDevDeliveryDelta, createIntegrationDeliveryProof, createProjectCutReplayPlan, createProjectCutReplayProof, createSourceQualificationProof, verifyIntegrationDeliveryProof, verifyProjectCutReplayProof, verifySourceQualificationProof } from "../packages/core/dev-delivery-warrant.js";

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function jsonFile(file, label) {
  if (!file) throw new Error(`${label} is required`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function jsonList(value, label, { required = false } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(value || "[]");
  } catch (cause) {
    throw new Error(`${label} must be a JSON array: ${cause.message}`);
  }
  if (!Array.isArray(parsed) || (required && parsed.length === 0)) {
    throw new Error(`${label} must be ${required ? "a non-empty" : "a"} JSON array`);
  }
  return parsed;
}

function boolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function devDeliveryProofCliOptions(args = [], environment = process.env) {
  const [command = "", ...rest] = args;
  return {
    command,
    repository: flag(rest, "repository", environment.GITHUB_REPOSITORY),
    protectedBase: flag(rest, "branch", environment.BUILDCHAIN_DEV_DELIVERY_BRANCH || environment.GITHUB_BASE_REF),
    sourceIdentityRoot: flag(rest, "source-identity-root", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_IDENTITY_ROOT),
    sourceHead: flag(rest, "source-head", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_HEAD),
    sourcePatchRoot: flag(rest, "source-patch-root", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PATCH_ROOT),
    planRoot: flag(rest, "plan-root", environment.BUILDCHAIN_DEV_DELIVERY_PLAN_ROOT),
    closureRoot: flag(rest, "closure-root", environment.BUILDCHAIN_DEV_DELIVERY_CLOSURE_ROOT),
    dependencyRoot: flag(rest, "dependency-root", environment.BUILDCHAIN_DEV_DELIVERY_DEPENDENCY_ROOT),
    toolchainRoot: flag(rest, "toolchain-root", environment.BUILDCHAIN_DEV_DELIVERY_TOOLCHAIN_ROOT),
    affectedPaths: flag(rest, "affected-paths-json", environment.BUILDCHAIN_DEV_DELIVERY_AFFECTED_PATHS || "[]"),
    shardEvidenceRoots: flag(rest, "shard-evidence-roots-json", environment.BUILDCHAIN_DEV_DELIVERY_SHARD_EVIDENCE_ROOTS || "[]"),
    qualifiedAt: flag(rest, "qualified-at", environment.BUILDCHAIN_DEV_DELIVERY_QUALIFIED_AT),
    sourceProofPath: flag(rest, "source-proof", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PROOF),
    sourceProofRoot: flag(rest, "source-proof-root", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PROOF_ROOT),
    warrantResultPath: flag(rest, "warrant-result", environment.BUILDCHAIN_DEV_DELIVERY_WARRANT_RESULT),
    currentBase: flag(rest, "current-base", environment.BUILDCHAIN_DEV_DELIVERY_CURRENT_BASE),
    previousBase: flag(rest, "previous-base", environment.BUILDCHAIN_DEV_DELIVERY_PREVIOUS_BASE),
    replayTree: flag(rest, "replay-tree", environment.BUILDCHAIN_DEV_DELIVERY_REPLAY_TREE),
    qualificationReceiptPath: flag(rest, "qualification-receipt", environment.BUILDCHAIN_DEV_DELIVERY_QUALIFICATION_RECEIPT),
    mergeGroupHead: flag(rest, "merge-group-head", environment.BUILDCHAIN_DEV_DELIVERY_MERGE_GROUP_HEAD),
    mergeGroupTree: flag(rest, "merge-group-tree", environment.BUILDCHAIN_DEV_DELIVERY_MERGE_GROUP_TREE),
    requiredContextRoots: flag(rest, "required-context-roots-json", environment.BUILDCHAIN_DEV_DELIVERY_REQUIRED_CONTEXT_ROOTS || "[]"),
    verifiedAt: flag(rest, "verified-at", environment.BUILDCHAIN_DEV_DELIVERY_VERIFIED_AT),
    pullRequestNumber: flag(rest, "pull-request", environment.BUILDCHAIN_DEV_DELIVERY_PR_NUMBER),
    changedPaths: flag(rest, "changed-paths-json", environment.BUILDCHAIN_DEV_DELIVERY_CHANGED_PATHS || "[]"),
    graphKnown: boolean(flag(rest, "graph-known", environment.BUILDCHAIN_DEV_DELIVERY_GRAPH_KNOWN), false),
    outputPath: flag(rest, "output", environment.BUILDCHAIN_DEV_DELIVERY_PROOF_OUTPUT || ".buildchain/dev-delivery/proof.json"),
    json: hasFlag(rest, "json"),
  };
}

function sourceProof(options) {
  return createSourceQualificationProof({
    repository: options.repository,
    protectedBase: options.protectedBase,
    sourceIdentityRoot: options.sourceIdentityRoot,
    sourceHead: options.sourceHead,
    sourcePatchRoot: options.sourcePatchRoot,
    planRoot: options.planRoot,
    closureRoot: options.closureRoot,
    dependencyRoot: options.dependencyRoot,
    toolchainRoot: options.toolchainRoot,
    affectedPaths: jsonList(options.affectedPaths, "affected paths"),
    shardEvidenceRoots: jsonList(options.shardEvidenceRoots, "shard evidence roots", { required: true }),
    qualifiedAt: options.qualifiedAt,
  });
}

function activeWarrant(options) {
  const result = jsonFile(options.warrantResultPath, "Warrant result");
  const warrant = result.warrant || result.observation?.activeWarrant;
  if (result.schema !== "kungfu.buildchain.dev-delivery-command-result/v1" || !warrant) {
    throw new Error("Warrant result does not contain an active Buildchain Delivery Warrant");
  }
  return warrant;
}

export function runDevDeliveryProofCommand(options) {
  if (options.command === "source") return sourceProof(options);
  if (options.command === "verify-source") {
    return verifySourceQualificationProof(jsonFile(options.sourceProofPath, "source proof"));
  }
  if (options.command === "classify") {
    return classifyDevDeliveryDelta({
      proof: jsonFile(options.sourceProofPath, "source proof"),
      current: {
        sourceIdentityRoot: options.sourceIdentityRoot,
        sourcePatchRoot: options.sourcePatchRoot,
        planRoot: options.planRoot,
        closureRoot: options.closureRoot,
        dependencyRoot: options.dependencyRoot,
        toolchainRoot: options.toolchainRoot,
        graphKnown: options.graphKnown,
        changedPaths: jsonList(options.changedPaths, "changed paths"),
      },
    });
  }
  if (options.command === "replay") {
    return createProjectCutReplayPlan({
      repository: options.repository,
      protectedBase: options.protectedBase,
      pullRequestNumber: options.pullRequestNumber,
      sourceHead: options.sourceHead,
      previousBase: options.previousBase,
      currentBase: options.currentBase,
      sourcePatchRoot: options.sourcePatchRoot,
      replayTree: options.replayTree,
    });
  }
  if (options.command === "replay-proof") {
    return createProjectCutReplayProof({
      repository: options.repository,
      protectedBase: options.protectedBase,
      pullRequestNumber: options.pullRequestNumber,
      sourceHead: options.sourceHead,
      sourcePatchRoot: options.sourcePatchRoot,
      currentBase: options.currentBase,
      replayTree: options.replayTree,
      qualificationReceipt: jsonFile(options.qualificationReceiptPath, "Project Cut qualification receipt"),
      requiredContextRoots: jsonList(options.requiredContextRoots, "required context roots", { required: true }),
      verifiedAt: options.verifiedAt,
    });
  }
  if (options.command === "verify-replay") {
    return verifyProjectCutReplayProof(jsonFile(options.sourceProofPath, "Project Cut replay proof"));
  }
  if (options.command === "integration") {
    const sourceProofRoot = options.sourceProofRoot || jsonFile(options.sourceProofPath, "source proof").proofRoot;
    return createIntegrationDeliveryProof({
      repository: options.repository,
      protectedBase: options.protectedBase,
      sourceProofRoot,
      currentBase: options.currentBase,
      replayTree: options.replayTree,
      mergeGroupHead: options.mergeGroupHead,
      mergeGroupTree: options.mergeGroupTree,
      warrant: activeWarrant(options),
      requiredContextRoots: jsonList(options.requiredContextRoots, "required context roots", { required: true }),
      verifiedAt: options.verifiedAt,
    });
  }
  if (options.command === "verify-integration") {
    return verifyIntegrationDeliveryProof(jsonFile(options.sourceProofPath, "integration proof"));
  }
  throw new Error("unsupported dev delivery proof command");
}

function usage() {
  return "Usage:\n  buildchain dev proof <source|verify-source|classify|replay|replay-proof|verify-replay|integration|verify-integration> [options] [--output FILE] [--json]\n";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || hasFlag(args, "help")) {
    process.stdout.write(usage());
    return;
  }
  const options = devDeliveryProofCliOptions(args);
  const result = runDevDeliveryProofCommand(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`Buildchain dev delivery proof ${options.command}: ${result.proofRoot || result.reason}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`buildchain dev proof: ${error.message}`);
    process.exit(1);
  });
}
