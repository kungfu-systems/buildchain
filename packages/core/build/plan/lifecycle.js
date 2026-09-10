import path from "node:path";
import { artifactNames } from "../artifact/contracts.js";
export function lifecycleOptions(plan, platform, stage, root) {
  const names = artifactNames(plan, platform);
  const directory = `.buildchain/artifacts/${platform.id}`;
  const final = stage === "verify" || stage === "signing-finalization";
  const sampled = plan.build.diagnostics.sample_process_tree;
  return {
    cwd: path.join(root, plan.project.cwd),
    workspace: root,
    stageName: stage,
    required: plan.lifecycle[stage]?.required || false,
    timeoutMinutes: plan.build.timeout_minutes,
    artifactName: names.payload,
    manifestArtifactName: names.manifest,
    diagnosticsArtifactName: names.diagnostics,
    platformId: platform.id,
    platformName: platform.name,
    artifactPaths: [
      ...plan.artifacts.paths.split("\n"),
      ...(final ? [".buildchain/artifacts/signing"] : []),
    ],
    manifestPath: `${directory}/${final ? "manifest" : `manifest-${stage}`}.json`,
    summaryPath: `${directory}/${final ? "summary" : `summary-${stage}`}.json`,
    expectedArtifactsJson: final ? plan.artifacts.expected_json : "",
    sampleProcessTree: stage === "build" && sampled,
    processSummaryPath:
      stage !== "install" && sampled
        ? ".buildchain/diagnostics/process-summary.json"
        : "",
    processSamplesPath: ".buildchain/diagnostics/process-samples.jsonl",
    processSampleIntervalMs: plan.build.diagnostics.sample_interval_ms,
    requestedParallelism: plan.build.diagnostics.requested_parallelism,
    processSummaryRequired: stage !== "signing-finalization",
    substageEvidencePath:
      stage === "verify" ? plan.build.verification.substage_evidence_path : "",
  };
}
