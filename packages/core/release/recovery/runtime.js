import { readOnlyJson } from "./files.js";
import { readPublicResumeState } from "./readback.js";
import { resolveRuntimeResumePublicRuntimeSha } from "./readback.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { authorizeRuntimeSelection } from "../../consumer/runtime-ref-resume-authority.js";
import { createRuntimeResumeLineage } from "../../consumer/runtime-ref-resume-authority.js";
import { scanRuntimeSelectorPersistence } from "../../consumer/runtime-ref-resume-authority.js";
import { runtimeResumeDocumentRoot } from "../../consumer/runtime-ref-resume-authority.js";
import { verifyRuntimeAuthorizationReceipt } from "../../consumer/runtime-ref-resume-authority.js";
import { splitRepository } from "../candidate/selection.js";
import { installationRoot } from "../../runtime/installation-root.js";
export function trackedRuntimePersistenceScan({
  runtimeRoot = installationRoot(import.meta.url),
} = {}) {
  const paths = execFileSync(
    "git",
    [
      "-C",
      runtimeRoot,
      "ls-files",
      ".github/workflows",
      "actions",
      ".buildchain",
    ],
    { encoding: "utf8" },
  )
    .split(/\r?\n/)
    .filter((entry) => /\.(?:json|toml|ya?ml)$/u.test(entry));
  return scanRuntimeSelectorPersistence({ root: runtimeRoot, paths });
}

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
  runtimeRoot,
  recoveryRunId,
  recoveryRunAttempt,
  authorizationPath,
  authorizationJson,
  authorizationRoot,
}) {
  const delegatedRaw = String(authorizationJson || "").trim();
  const delegatedRoot = String(authorizationRoot || "").trim();
  const authorizationFileExists =
    authorizationPath && fs.existsSync(authorizationPath);
  if (!authorizationFileExists && (!delegatedRaw || !delegatedRoot))
    throw new Error(
      "cross-runtime recovery requires a fresh runtime authorization receipt",
    );
  const delegated = authorizationFileExists
    ? readOnlyJson(
        [{ absolutePath: authorizationPath }],
        "runtime authorization",
      )
    : JSON.parse(delegatedRaw);
  if (!authorizationFileExists && delegated.receiptRoot !== delegatedRoot)
    throw new Error(
      "fresh recovery runtime authorization handoff root mismatch",
    );
  const delegatedVerification = verifyRuntimeAuthorizationReceipt({
    receipt: delegated.receipt,
    receiptRoot: delegated.receiptRoot,
    repository: repoInfo.fullName,
    runtimeSha,
  });
  if (!delegatedVerification.ok) {
    throw new Error(
      `fresh recovery runtime authorization rejected: ${delegatedVerification.failures.join(", ")}`,
    );
  }
  const policy = passport.consumerPolicy.receipt;
  const authorization = authorizeRuntimeSelection({
    repository: repoInfo.fullName,
    eventName: "workflow_dispatch",
    mode: "resume",
    actor: delegated.receipt.actor.login,
    actorPermission: delegated.receipt.actor.permission,
    reason: `resume sealed candidate run ${passport.workflow.runId} from a tree-equivalent protected source`,
    authorizedAt: new Date().toISOString(),
    sourceSha: sidecar.source.sha,
    sourceTreeSha: sidecar.source.treeSha,
    requestedRef: delegated.receipt.request.ref,
    resolvedRuntimeSha: runtimeSha,
    approvedRefReadbacks: delegated.receipt.runtime.reachableFrom,
    stableContractLockRoot: policy.contractLocks.stable.root,
    alphaContractLockRoot: policy.contractLocks.alpha.root,
    consumerPolicyReceiptRoot: sidecar.consumerPolicyReceiptRoot,
    persistenceScan: trackedRuntimePersistenceScan({ runtimeRoot }),
  });
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
    authorization: authorization.receipt,
    authorizationRoot: authorization.receiptRoot,
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
    floatingRefBefore: {
      ref: "v4-alpha",
      sha: sidecar.buildAttempt.runtimeSha,
    },
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
    runtimeSha: resolveRuntimeResumePublicRuntimeSha(material),
    version,
    transaction,
    token,
    apiUrl,
    fetchImpl,
  });
  const resumed = createRuntimeResumeLineage({
    authorization: material.authorization,
    authorizationRoot: material.authorizationRoot,
    buildAttempt: material.buildAttempt,
    resumeAttempt: material.resumeAttempt,
    source: material.source,
    consumerPolicyReceiptRoot: material.consumerPolicyReceiptRoot,
    requiredPlatforms: material.requiredPlatforms,
    stageCapsules: material.stageCapsules,
    resumePlanRoot: material.resumePlanRoot,
    finalPublicReadbackRoot: readback.root,
    floatingRefBefore: material.floatingRefBefore,
    floatingRefAfter: { ref: "v4-alpha", sha: readback.refs.floating.sha },
  });
  const evidence = {
    authorization: material.authorization,
    authorizationRoot: material.authorizationRoot,
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
