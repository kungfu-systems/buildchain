import fs from "node:fs";
import path from "node:path";
import {
  createBuildchainContractWorld,
  evaluateBuildchainContractLock,
  readBuildchainContractLock,
  readBuildchainContractWorld,
  renderBuildchainContractDriftIssueBody,
} from "./buildchain-contract.js";

function readCurrentContract(contractPath, runtimeRoot) {
  if (contractPath && fs.existsSync(contractPath)) {
    return readBuildchainContractWorld(contractPath);
  }
  return createBuildchainContractWorld({ root: runtimeRoot || process.cwd() });
}

function issueModeAllows(mode, evaluation) {
  if (!evaluation.issueRecommended) {
    return false;
  }
  if (mode === "off") {
    return false;
  }
  if (mode === "breaking-only") {
    return evaluation.status === "breaking-drift";
  }
  return mode === "compatible-and-breaking";
}

export function inspectRuntimeContract({
  lockPath,
  currentContractPath,
  runtimeRoot,
  runtimeRef,
  runtimeSha,
  runtimeClass,
  compatibilityPolicy,
  workflowShellRef,
  expectedChannel,
  expectedMajor,
  allowOpaqueRuntime,
  issueMode = "compatible-and-breaking",
  issueBodyPath,
  repository,
  workflow,
  runUrl,
}) {
  const current = readCurrentContract(currentContractPath, runtimeRoot);
  const lock = readBuildchainContractLock(lockPath);
  const evaluation = evaluateBuildchainContractLock({
    lock,
    current,
    runtimeRef,
    runtimeSha,
    runtimeClass,
    compatibilityPolicy,
    workflowShellRef,
    expectedChannel,
    expectedMajor,
    allowOpaqueRuntime,
  });
  const shouldIssue = issueModeAllows(issueMode, evaluation);
  if (shouldIssue) {
    const body = renderBuildchainContractDriftIssueBody({
      repository,
      workflow,
      runUrl,
      lockPath,
      evaluation,
    });
    fs.mkdirSync(path.dirname(issueBodyPath), { recursive: true });
    fs.writeFileSync(issueBodyPath, `${body}\n`);
  }
  const summary = [
    "## Buildchain contract lock",
    "",
    `- Status: \`${evaluation.status}\``,
    `- Compatible: \`${evaluation.compatible ? "true" : "false"}\``,
    `- Runtime ref: \`${runtimeRef || "(unknown)"}\``,
    `- Runtime SHA: \`${runtimeSha || "(unknown)"}\``,
    `- Workflow shell ref: \`${workflowShellRef || "(unknown)"}\``,
    evaluation.channelBinding
      ? `- Bound channel: \`${evaluation.channelBinding.channel || "(unknown)"}\``
      : "",
    `- Contract digest: \`${current.contractDigest}\``,
    `- Compatibility digest: \`${current.compatibilityDigest}\``,
    evaluation.reasons?.length
      ? `- Reasons: ${evaluation.reasons.join("; ")}`
      : "",
    shouldIssue ? `- Drift issue body: \`${issueBodyPath}\`` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const outputs = {
    "contract-lock-status": evaluation.status,
    "contract-lock-compatible": String(evaluation.compatible === true),
    "contract-lock-drift": String(evaluation.drift === true),
    "contract-lock-issue-needed": String(shouldIssue),
    "contract-lock-issue-body-file": shouldIssue ? issueBodyPath : "",
    "contract-digest": current.contractDigest,
    "contract-compatibility-digest": current.compatibilityDigest,
    "accepted-contract-digest": evaluation.accepted?.contractDigest || "",
    "accepted-buildchain-sha": evaluation.accepted?.resolvedSha || "",
    "current-buildchain-sha": runtimeSha || "",
  };
  return { evaluation, current, shouldIssue, summary, outputs };
}

export function assertRuntimeContractAccepted(result) {
  if (!result.evaluation.ok)
    throw new Error(
      `Buildchain contract lock rejected: ${(result.evaluation.reasons || []).join("; ")}`,
    );
}
