import crypto from "node:crypto";
import { fileFact, required, writeJson } from "./io.js";
import { REUSE_DECISION_SCHEMA } from "./reuse.js";
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
      qualifiedBase: decision.qualifiedBase,
      currentBase: decision.currentBase,
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
