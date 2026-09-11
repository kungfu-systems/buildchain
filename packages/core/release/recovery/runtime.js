import fs from "node:fs";
import path from "node:path";
import { readPublicResumeState } from "./readback.js";
import { createRuntimeResumeLineage, runtimeResumeDocumentRoot } from "./lineage.js";
import { splitRepository } from "../candidate/selection.js";
export function prepareRuntimeResumeEvidence({
  repoInfo,
  targetRef,
  runtimeSha,
  version,
  passport,
  sidecar,
  stageCapsules,
  recovery,
  outputDir,
  recoveryRunId,
  recoveryRunAttempt,
}) {
  const planBody = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-runtime-resume-plan/v1",
    originalRunId: String(passport.workflow.runId),
    resumeRunId: String(recoveryRunId),
    recoveryReceiptRoot: recovery.receipt.root,
    requiredPlatforms: stageCapsules.map((entry) => entry.platform),
    reusedCapsuleRoots: stageCapsules.map((entry) => entry.capsuleRoot),
    rebuildPlatforms: [],
    skippedBuildStages: recovery.receipt.skippedBuildStages,
  };
  const plan = { ...planBody, root: runtimeResumeDocumentRoot(planBody) };
  const materialBody = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-runtime-resume-material/v1",
    repository: repoInfo.fullName,
    targetRef,
    runtimeSha,
    version,
    buildAttempt: sidecar.buildAttempt,
    resumeAttempt: {
      id: `github-run:${recoveryRunId}:attempt:${recoveryRunAttempt}`,
      runtimeSha,
    },
    source: sidecar.source,
    consumerPolicyReceiptRoot: sidecar.consumerPolicyReceiptRoot,
    requiredPlatforms: stageCapsules.map((entry) => entry.platform),
    stageCapsules,
    resumePlanRoot: plan.root,

  };
  const material = {
    ...materialBody,
    root: runtimeResumeDocumentRoot(materialBody),
  };
  for (const [name, value] of [
    ["v4-runtime-resume-plan.json", plan],
    ["v4-runtime-resume-material.json", material],
  ]) {
    fs.writeFileSync(
      path.join(outputDir, name),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }
  return path.join(outputDir, "v4-runtime-resume-evidence.json");
}

export async function finalizeRuntimeResumeEvidence({
  materialPath,
  transaction,
  expectedVersion,
  expectedTargetRef,
  token = "",
  apiUrl = "https://api.github.com",
  fetchImpl = globalThis.fetch,
  outputDir = path.dirname(materialPath),
}) {
  const material = JSON.parse(fs.readFileSync(materialPath, "utf8"));
  const body = { ...material };
  delete body.root;
  if (
    material.contract !== "kungfu-buildchain-v4-runtime-resume-material/v1" ||
    material.root !== runtimeResumeDocumentRoot(body)
  ) {
    throw new Error("cross-runtime resume material root mismatch");
  }
  const repoInfo = splitRepository(material.repository);
  const version = expectedVersion || material.version;
  const targetRef = expectedTargetRef || material.targetRef;
  if (
    version !== material.version ||
    targetRef !== material.targetRef ||
    transaction?.version !== version ||
    transaction?.state !== "complete"
  ) {
    throw new Error(
      "cross-runtime resume finalization does not match the completed publication transaction",
    );
  }
  const readback = await readPublicResumeState({
    repoInfo,
    targetRef,
    version,
    transaction,
    token,
    apiUrl,
    fetchImpl,
  });
  const resumed = createRuntimeResumeLineage({
    repository: material.repository,
    buildAttempt: material.buildAttempt,
    resumeAttempt: material.resumeAttempt,
    source: material.source,
    consumerPolicyReceiptRoot: material.consumerPolicyReceiptRoot,
    requiredPlatforms: material.requiredPlatforms,
    stageCapsules: material.stageCapsules,
    resumePlanRoot: material.resumePlanRoot,
    finalPublicReadbackRoot: readback.root,
  });
  const evidence = {
    lineage: resumed.lineage,
    lineageRoot: resumed.lineageRoot,
  };
  const evidencePath = path.join(outputDir, "v4-runtime-resume-evidence.json");
  for (const [name, value] of [
    ["v4-runtime-resume-public-readback.json", readback],
    [path.basename(evidencePath), evidence],
  ]) {
    fs.writeFileSync(
      path.join(outputDir, name),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }
  return { evidence, path: evidencePath, readback };
}
