import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { sourceCoordinates, validateNativeContract } from "./coordinates.js";
import {
  verifyProjectCutReplayProof,
  createSourceQualificationProof,
} from "../dev-delivery-warrant.js";
import { jsonList } from "../warrant/values.js";
import { writeJson } from "../native/files.js";
import { GitHubTwoPhaseClient } from "../../providers/dev-delivery/candidate.js";
import { assertBranchUnlocked } from "../../providers/dev-delivery/protection.js";
import { deriveSourcePaths } from "./source-paths.js";
import { admissionPolicyRequest } from "../admission/request.js";
import { runAdmissionTransaction } from "../admission/transaction.js";
import { guardPipelineAdmission } from "../../workflow/pipeline/guard.js";
export function admitDeliveryRequest(input, defaultBranch) {
  const target = sourceCoordinates({
    branch: input["target-branch"],
    defaultBranch,
    warrantMode: input["delivery-warrant-mode"],
    pullRequestNumber: input["expected-pr-number"],
    expectedHead: input["expected-head-sha"],
    dryRun: input["dry-run"],
  });
  if (input["delivery-warrant-mode"] === "required")
    validateNativeContract({
      deliveryClass: input["delivery-class"],
      environmentRoot: input["environment-root"],
    });
  return target;
}
export async function qualifyDeliverySource(
  {
    workspace,
    runtimeSha,
    runtimeRef,
    request,
    repository,
    branch,
    token,
    apiUrl,
    environment,
  },
  dependencies = {},
) {
  await guardPipelineAdmission(request, { repository, token });
  const outputs = {
    "runtime-sha": runtimeSha,
    "qualify-outcome": "skipped",
    "proof-outcome": "skipped",
    "project-cut-proof-root": "",
  };
  const emit = (values) => {
    Object.assign(outputs, values);
    dependencies.onEvidence?.(values);
  };
  const writeEvidence = (name, value) =>
    writeJson(path.join(workspace, ".buildchain/dev-delivery", name), value);
  const runtime = {
    schema: "kungfu.buildchain.dev-delivery-runtime-selection/v1",
    repository: "kungfu-systems/buildchain",
    selector: runtimeRef,
    resolvedSha: runtimeSha,
  };
  writeEvidence("runtime-selection.json", runtime);
  emit({
    "runtime-sha": runtimeSha,
    "runtime-root": `sha256:${crypto
      .createHash("sha256")
      .update(
        fs.readFileSync(
          path.join(
            workspace,
            ".buildchain/dev-delivery/runtime-selection.json",
          ),
        ),
      )
      .digest("hex")}`,
  });
  if (request["delivery-warrant-mode"] === "required")
    await assertBranchUnlocked(
      { repository, branch },
      dependencies.provider ||
        new GitHubTwoPhaseClient({ repository, token, apiUrl }),
    );
  let projectCutProofPath = "";
  if (request["project-cut-proof-json"]) {
    const proof = JSON.parse(request["project-cut-proof-json"]);
    writeEvidence("project-cut-proof.json", proof);
    const verification = verifyProjectCutReplayProof(proof);
    writeEvidence("project-cut-verification.json", verification);
    if (!verification.ok || verification.reason !== "exact-project-cut-replay")
      throw new Error("Project Cut replay verification failed");
    projectCutProofPath = path.join(
      workspace,
      ".buildchain/dev-delivery/project-cut-proof.json",
    );
    emit({ "project-cut-proof-root": proof.proofRoot });
  }
  if (request["delivery-warrant-mode"] === "off") return outputs;
  let qualification;
  try {
    qualification = await (dependencies.admit || runAdmissionTransaction)(
      {
        ...admissionPolicyRequest(request, { repository, branch, workspace }),
        qualificationOnly: true,
        landingMode: "queue",
        projectCutProofPath,
        outputPath: path.join(
          workspace,
          ".buildchain/dev-delivery/source-admission.json",
        ),
        dryRun: !(
          request["delivery-warrant-mode"] === "required" ||
          (request["delivery-warrant-mode"] === "shadow" &&
            request["dry-run"] !== true)
        ),
      },
      { token, apiUrl, useGhCli: false },
    );
    dependencies.onQualification?.(qualification);
    if (!qualification.ok) {
      emit({ "qualify-outcome": "failure" });
      return outputs;
    }
  } catch (error) {
    writeEvidence("source-qualification-error.json", { reason: error.message });
    emit({ "qualify-outcome": "failure" });
    return outputs;
  }
  emit({ "qualify-outcome": "success" });
  const source = {
    repository,
    branch,
    pullRequestNumber: Number(request["expected-pr-number"]),
    expectedHead: request["expected-head-sha"],
    sourceIdentityRoot: request["source-identity-root"],
    sourceWorkflowRunId: request["source-workflow-run-id"],
  };
  let affectedPaths = jsonList(
    request["affected-paths-json"],
    "Affected paths",
  );
  if (!affectedPaths.length)
    affectedPaths = await (dependencies.derivePaths || deriveSourcePaths)(
      source,
      { token, apiUrl, environment },
    );
  const receiptRoot = qualification.result.receiptRoot;
  if (!/^sha256:[0-9a-f]{64}$/u.test(receiptRoot || ""))
    throw new Error("Source admission receipt root is missing");
  const proof = createSourceQualificationProof({
    repository,
    protectedBase: branch,
    sourceIdentityRoot: request["source-identity-root"],
    sourceHead: source.expectedHead,
    sourcePatchRoot: request["source-patch-root"],
    planRoot: request["plan-root"],
    closureRoot: request["closure-root"],
    dependencyRoot: request["dependency-root"],
    toolchainRoot: request["toolchain-root"],
    affectedPaths,
    shardEvidenceRoots: [receiptRoot],
    qualifiedAt: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
  });
  writeEvidence("source-proof.json", proof);
  emit({ "source-proof-root": proof.proofRoot, "proof-outcome": "success" });
  return outputs;
}
