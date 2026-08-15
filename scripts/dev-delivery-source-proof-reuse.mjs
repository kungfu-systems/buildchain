#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  classifyDevDeliveryDelta,
  createSourceQualificationProofV2,
  devDeliveryContentRoot,
  verifySourceQualificationProof,
} from "../packages/core/dev-delivery-warrant.js";
import { validateControllerReceipt } from "../packages/core/controller-evidence.js";

const REUSE_DECISION_SCHEMA =
  "kungfu.buildchain.source-qualification-reuse-decision/v1";
const SHA = /^[0-9a-f]{40}$/u;

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function exactSha(value, label) {
  const normalized = required(value, label).toLowerCase();
  if (!SHA.test(normalized))
    throw new Error(`${label} must be an exact 40-hex Git SHA`);
  return normalized;
}

function jsonList(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value || "[]");
  } catch (error) {
    throw new Error(`${label} must be a JSON array: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error(`${label} must be a non-empty JSON array`);
  return [
    ...new Set(
      parsed.map((entry) => String(entry || "").trim()).filter(Boolean),
    ),
  ].sort();
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(required(filePath, label), "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  const target = path.resolve(required(filePath, "output"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function git(args, { cwd = process.cwd(), encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${String(result.stderr || "").trim()}`,
    );
  return encoding === null ? result.stdout : String(result.stdout || "").trim();
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function fileFact(filePath, workspace) {
  const absolute = path.resolve(filePath);
  return {
    path: path
      .relative(path.resolve(workspace), absolute)
      .split(path.sep)
      .join("/"),
    size: fs.statSync(absolute).size,
    sha256: sha256(fs.readFileSync(absolute)),
  };
}

function gitPathRoot(ref, paths, label, cwd) {
  const files = paths.map((filePath) => {
    const normalized = filePath.replace(/^\.\//u, "");
    if (!normalized || normalized.includes("\n"))
      throw new Error(`${label} contains an invalid path`);
    return {
      path: normalized,
      blob: exactSha(
        git(["rev-parse", `${ref}:${normalized}`], { cwd }),
        `${label} blob for ${normalized}`,
      ),
    };
  });
  return devDeliveryContentRoot({
    schema: "kungfu.buildchain.git-path-set/v1",
    label,
    files,
  });
}

function exactMergeGroupBinding(input = {}) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const mergeGroupHead = exactSha(input.mergeGroupHead, "mergeGroupHead");
  const expectedTree = exactSha(input.mergeGroupTree, "mergeGroupTree");
  const currentBase = exactSha(input.currentBase, "currentBase");
  const sourceHead = exactSha(input.sourceHead, "sourceHead");
  const actualTree = exactSha(
    git(["rev-parse", `${mergeGroupHead}^{tree}`], { cwd }),
    "mergeGroupTree",
  );
  if (actualTree !== expectedTree)
    return { ok: false, reason: "merge-group-tree-mismatch" };
  const [commit, ...parents] = git(
    ["rev-list", "--parents", "-n", "1", mergeGroupHead],
    { cwd },
  ).split(/\s+/u);
  if (commit !== mergeGroupHead) {
    return { ok: false, reason: "merge-group-parent-mismatch" };
  }
  if (
    parents.length === 2 &&
    parents[0] === currentBase &&
    parents[1] === sourceHead
  ) {
    return {
      ok: true,
      mergeGroupHead,
      mergeGroupTree: actualTree,
      parents,
      compositionMode: "two-parent-merge",
      replayedCommitTrees: [],
    };
  }

  const linearRange = (head) => {
    try {
      git(["merge-base", "--is-ancestor", currentBase, head], { cwd });
    } catch {
      return null;
    }
    const commits = git(
      ["rev-list", "--reverse", "--topo-order", `${currentBase}..${head}`],
      { cwd },
    )
      .split(/\s+/u)
      .filter(Boolean);
    if (commits.length === 0) return null;
    let expectedParent = currentBase;
    const trees = [];
    for (const rangeCommit of commits) {
      const [observedCommit, ...rangeParents] = git(
        ["rev-list", "--parents", "-n", "1", rangeCommit],
        { cwd },
      ).split(/\s+/u);
      if (
        observedCommit !== rangeCommit ||
        rangeParents.length !== 1 ||
        rangeParents[0] !== expectedParent
      ) {
        return null;
      }
      trees.push(
        exactSha(
          git(["rev-parse", `${rangeCommit}^{tree}`], { cwd }),
          "replayedCommitTree",
        ),
      );
      expectedParent = rangeCommit;
    }
    return trees;
  };

  const sourceTrees = linearRange(sourceHead);
  const mergeGroupTrees = linearRange(mergeGroupHead);
  if (
    !sourceTrees ||
    !mergeGroupTrees ||
    sourceTrees.length !== mergeGroupTrees.length ||
    sourceTrees.some((tree, index) => tree !== mergeGroupTrees[index])
  ) {
    return { ok: false, reason: "merge-group-parent-mismatch" };
  }
  return {
    ok: true,
    mergeGroupHead,
    mergeGroupTree: actualTree,
    parents,
    compositionMode: "linear-replay",
    replayedCommitTrees: mergeGroupTrees,
  };
}

export function sourceQualificationPredicates(input = {}) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const repository = required(input.repository, "repository");
  const protectedBase = required(input.protectedBase, "protectedBase");
  const qualifiedBase = exactSha(input.qualifiedBase, "qualifiedBase");
  const sourceHead = exactSha(input.sourceHead, "sourceHead");
  const sourceTree = exactSha(
    git(["rev-parse", `${sourceHead}^{tree}`], { cwd }),
    "sourceTree",
  );
  const policyPaths = jsonList(input.policyPaths, "policy paths");
  const closurePaths = jsonList(input.closurePaths, "closure paths");
  const dependencyPaths = jsonList(input.dependencyPaths, "dependency paths");
  const requiredContexts = jsonList(
    input.requiredContexts,
    "required contexts",
  );
  const affectedPaths = git(
    ["diff", "--name-only", "--no-renames", `${qualifiedBase}...${sourceHead}`],
    { cwd },
  )
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  const patch = git(
    [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      `${qualifiedBase}...${sourceHead}`,
    ],
    {
      cwd,
      encoding: null,
    },
  );
  const runtimeRef = required(input.runtimeRef, "runtimeRef");
  const runtimeSha = exactSha(input.runtimeSha, "runtimeSha");
  const contractDigest = required(input.contractDigest, "contractDigest");
  const nodeVersion = required(input.nodeVersion, "nodeVersion");
  return {
    repository,
    protectedBase,
    qualifiedBase,
    sourceHead,
    sourceTree,
    sourceIdentityRoot: devDeliveryContentRoot({
      schema: "kungfu.buildchain.source-identity/v1",
      repository,
      protectedBase,
      qualifiedBase,
      sourceHead,
      sourceTree,
    }),
    sourcePatchRoot: sha256(patch),
    planRoot: devDeliveryContentRoot({
      schema: "kungfu.buildchain.source-qualification-plan/v1",
      mode: "source",
      workingDirectory: required(
        input.workingDirectory || ".",
        "workingDirectory",
      ),
      nodeVersion,
      policyPaths,
      closurePaths,
      dependencyPaths,
      requiredContexts,
    }),
    closureRoot: gitPathRoot(sourceHead, closurePaths, "source-closure", cwd),
    dependencyRoot: gitPathRoot(
      sourceHead,
      dependencyPaths,
      "source-dependencies",
      cwd,
    ),
    toolchainRoot: devDeliveryContentRoot({
      schema: "kungfu.buildchain.source-toolchain/v1",
      runtimeRef,
      runtimeSha,
      contractDigest,
      nodeVersion,
    }),
    policyRoot: gitPathRoot(sourceHead, policyPaths, "source-policy", cwd),
    requiredContextRoot: devDeliveryContentRoot({
      schema: "kungfu.buildchain.required-context-set/v1",
      contexts: requiredContexts,
    }),
    affectedPaths,
  };
}

export function sealSourceQualificationProof(input = {}) {
  const receipt = readJson(input.controllerReceiptPath, "controller receipt");
  const expectedSourceSha = exactSha(input.sourceHead, "sourceHead");
  const expectedRuntimeSha = exactSha(input.runtimeSha, "runtimeSha");
  const expectedRepository = required(input.repository, "repository");
  const validation = validateControllerReceipt(receipt, {
    expectedSourceSha,
    expectedRuntimeSha,
  });
  if (
    !validation.ok ||
    !validation.qualifying ||
    receipt.controller?.id !== "source-check" ||
    receipt.source?.repository !== expectedRepository
  ) {
    throw new Error(
      `controller receipt is not qualifying: ${validation.issues.join("; ") || receipt.status || "unknown"}`,
    );
  }
  const predicates = sourceQualificationPredicates(input);
  return createSourceQualificationProofV2({
    ...predicates,
    controllerReceiptRoot: receipt.digest,
    sourceWorkflowRunId: input.sourceWorkflowRunId,
    shardEvidenceRoots: [receipt.digest],
    qualifiedAt: input.qualifiedAt,
  });
}

function rootedDecision(body) {
  return { ...body, decisionRoot: devDeliveryContentRoot(body) };
}

export function materializeReuseLifecycleEvidence({
  decision,
  sourceProofPath,
  decisionPath,
  manifestPath,
  summaryPath,
  workspace = process.cwd(),
  repository = "",
  sourceRef = "",
  runId = "",
  runAttempt = "",
  platformId = process.platform,
  platformName = platformId,
  runnerOs = process.platform,
  runnerArch = process.arch,
} = {}) {
  if (!decision?.reusable || decision.action !== "reuse-source-qualification") {
    throw new Error(
      "reuse lifecycle evidence requires a reusable source-proof decision",
    );
  }
  const files = [
    fileFact(required(sourceProofPath, "source proof"), workspace),
    fileFact(required(decisionPath, "reuse decision"), workspace),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const summary = {
    contract: "kungfu-buildchain-artifact-summary",
    artifactName: "buildchain-check",
    platform: String(platformId),
    fileCount: files.length,
    totalBytes: files.reduce((total, entry) => total + entry.size, 0),
    digest: crypto
      .createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex"),
  };
  const manifest = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact",
    artifactName: "buildchain-check",
    platform: {
      id: String(platformId),
      name: String(platformName),
      os: String(runnerOs),
      arch: String(runnerArch),
    },
    git: {
      repository: String(repository),
      sha: decision.mergeGroupHead,
      ref: String(sourceRef),
      runId: String(runId),
      runAttempt: String(runAttempt),
    },
    lifecycle: {
      stage: "check",
      commandSource: "exact-source-proof-reuse",
      executed: false,
      satisfiedBy: decision.sourceProofRoot,
    },
    qualification: {
      schema: REUSE_DECISION_SCHEMA,
      authority: decision.finalAuthority,
      sourceProofRoot: decision.sourceProofRoot,
      decisionRoot: decision.decisionRoot,
      sourceWorkflowRunId: decision.sourceWorkflowRunId,
      sourceHead: decision.sourceHead,
      qualifiedBase: decision.currentBase,
      mergeGroupHead: decision.mergeGroupHead,
      mergeGroupTree: decision.mergeGroupTree,
    },
    summary,
    expectedArtifacts: {
      ok: true,
      source: "exact-source-proof-reuse",
      checks: [
        {
          name: "source-proof-verification",
          ok: true,
          detail: decision.sourceProofRoot,
        },
      ],
    },
    files,
  };
  writeJson(manifestPath, manifest);
  writeJson(summaryPath, summary);
  return { manifest, summary };
}

export function verifySourceQualificationReuse(input = {}) {
  const proof = readJson(input.sourceProofPath, "source proof");
  const receipt = readJson(input.controllerReceiptPath, "controller receipt");
  const expectedSourceSha = exactSha(input.sourceHead, "sourceHead");
  const expectedRuntimeSha = exactSha(input.runtimeSha, "runtimeSha");
  const expectedRepository = required(input.repository, "repository");
  const receiptValidation = validateControllerReceipt(receipt, {
    expectedSourceSha,
    expectedRuntimeSha,
  });
  if (
    !receiptValidation.ok ||
    !receiptValidation.qualifying ||
    receipt.controller?.id !== "source-check" ||
    receipt.source?.repository !== expectedRepository
  ) {
    return rootedDecision({
      schema: REUSE_DECISION_SCHEMA,
      reusable: false,
      action: "rerun-full-source-qualification",
      reason: "producer-controller-receipt-not-qualifying",
    });
  }
  const verification = verifySourceQualificationProof(proof, {
    repository: required(input.repository, "repository"),
    protectedBase: required(input.protectedBase, "protectedBase"),
    qualifiedBase: exactSha(input.currentBase, "currentBase"),
    sourceHead: exactSha(input.sourceHead, "sourceHead"),
    sourceWorkflowRunId: Number(input.sourceWorkflowRunId),
    controllerReceiptRoot: receipt.digest,
  });
  if (!verification.ok) {
    return rootedDecision({
      schema: REUSE_DECISION_SCHEMA,
      reusable: false,
      action: "rerun-full-source-qualification",
      reason: verification.reason,
      ...(verification.error ? { diagnostic: verification.error } : {}),
    });
  }
  const current = sourceQualificationPredicates({
    ...input,
    qualifiedBase: input.currentBase,
  });
  const classification = classifyDevDeliveryDelta({
    proof,
    current: { ...current, graphKnown: true, changedPaths: [] },
  });
  if (!classification.reusable) {
    return rootedDecision({
      schema: REUSE_DECISION_SCHEMA,
      reusable: false,
      action: "rerun-full-source-qualification",
      reason: classification.reason,
    });
  }
  const mergeGroup = exactMergeGroupBinding(input);
  if (!mergeGroup.ok) {
    return rootedDecision({
      schema: REUSE_DECISION_SCHEMA,
      reusable: false,
      action: "rerun-full-source-qualification",
      reason: mergeGroup.reason,
    });
  }
  return rootedDecision({
    schema: REUSE_DECISION_SCHEMA,
    reusable: true,
    action: "reuse-source-qualification",
    reason: "exact-source-proof",
    sourceProofRoot: proof.proofRoot,
    sourceWorkflowRunId: proof.sourceWorkflowRunId,
    sourceHead: proof.sourceHead,
    currentBase: proof.qualifiedBase,
    mergeGroupHead: mergeGroup.mergeGroupHead,
    mergeGroupTree: mergeGroup.mergeGroupTree,
    mergeGroupParents: mergeGroup.parents,
    mergeGroupCompositionMode: mergeGroup.compositionMode,
    mergeGroupReplayTrees: mergeGroup.replayedCommitTrees,
    predicateRoots: {
      sourceIdentityRoot: proof.sourceIdentityRoot,
      sourcePatchRoot: proof.sourcePatchRoot,
      planRoot: proof.planRoot,
      closureRoot: proof.closureRoot,
      dependencyRoot: proof.dependencyRoot,
      toolchainRoot: proof.toolchainRoot,
      policyRoot: proof.policyRoot,
      requiredContextRoot: proof.requiredContextRoot,
    },
    warrantBinding: "sourceProofRoot",
    finalAuthority: "exact-merge-group-source-proof-verification",
    verifiedAt: required(input.verifiedAt, "verifiedAt"),
  });
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
    "usage: dev-delivery-source-proof-reuse.mjs <seal|verify> [options]",
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
