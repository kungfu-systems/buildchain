import fs from "node:fs";
import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { sealSourceQualificationProof } from "../../dev-delivery/source-proof/seal.js";
import {
  verifySourceQualificationReuse,
  rootedDecision,
  REUSE_DECISION_SCHEMA,
} from "../../dev-delivery/source-proof/reuse.js";
import { materializeReuseLifecycleEvidence } from "../../dev-delivery/source-proof/evidence.js";
import { writeJson } from "../../dev-delivery/source-proof/io.js";

export function sourceProofRequest({
  workspace,
  request,
  identities,
  runtimeRef,
  repository,
  protectedBase,
  sourceHead,
  sourceWorkflowRunId,
}) {
  return {
    cwd: workspace,
    repository,
    protectedBase: String(protectedBase || "").replace(/^refs\/heads\//, ""),
    sourceHead,
    sourceWorkflowRunId,
    runtimeRef,
    runtimeSha: identities["runtime-sha"],
    contractDigest: identities["contract-digest"],
    nodeVersion: request["node-version"],
    workingDirectory: request["working-directory"],
    policyPaths: request["source-proof-policy-paths-json"],
    closurePaths: request["source-proof-closure-paths-json"],
    dependencyPaths: request["source-proof-dependency-paths-json"],
    requiredContexts: request["source-proof-required-contexts-json"],
  };
}
export function fetchSourceProofCoordinates(input, execute = command) {
  const proof = JSON.parse(fs.readFileSync(input.sourceProofPath, "utf8"));
  const refs = {
    "merge-group-head": input.mergeGroupHead,
    "current-base": input.currentBase,
    "source-head": input.sourceHead,
    "qualified-base": proof.qualifiedBase,
  };
  if (!Object.values(refs).every((sha) => /^[0-9a-f]{40}$/.test(sha || "")))
    throw new Error("Source proof requires exact commit coordinates");
  execute(
    "git",
    [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--depth=64",
      "origin",
      ...Object.entries(refs).map(
        ([name, sha]) => `+${sha}:refs/buildchain/source-proof/${name}`,
      ),
    ],
    { cwd: input.cwd },
  );
  return execute("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: input.cwd,
    stdio: "pipe",
  }).trim();
}
export function evaluateSourceProof(
  input,
  runner,
  {
    fetch = fetchSourceProofCoordinates,
    verify = verifySourceQualificationReuse,
  } = {},
) {
  const directory = path.join(input.cwd, ".buildchain/source-proof");
  const sourceProofPath = path.join(directory, "source-proof.json"),
    outputPath = path.join(directory, "reuse-decision.json");
  let decision;
  try {
    const options = {
      ...input,
      sourceProofPath,
      controllerReceiptPath: path.join(directory, "controller-receipt.json"),
    };
    options.mergeGroupTree = fetch(options);
    decision = verify(options);
  } catch (error) {
    decision = rootedDecision({
      schema: REUSE_DECISION_SCHEMA,
      reusable: false,
      action: "rerun-full-source-qualification",
      reason: "unverifiable-proof",
      diagnostic: String(error.message || error),
    });
  }
  writeJson(outputPath, decision);
  if (decision.reusable)
    materializeReuseLifecycleEvidence({
      decision,
      sourceProofPath,
      decisionPath: outputPath,
      manifestPath: path.join(
        input.cwd,
        ".buildchain/artifacts/check-manifest.json",
      ),
      summaryPath: path.join(
        input.cwd,
        ".buildchain/artifacts/check-summary.json",
      ),
      workspace: input.cwd,
      repository: input.repository,
      ...runner,
    });
  return decision;
}
export function sealSourceProof(input) {
  const directory = path.join(input.cwd, ".buildchain/source-proof");
  const controllerReceiptPath = path.join(
    input.cwd,
    ".buildchain/controller/receipt.json",
  );
  const proof = sealSourceQualificationProof({
    ...input,
    controllerReceiptPath,
  });
  writeJson(path.join(directory, "source-proof.json"), proof);
  fs.copyFileSync(
    controllerReceiptPath,
    path.join(directory, "controller-receipt.json"),
  );
  return proof;
}
