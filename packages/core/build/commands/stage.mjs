import fs from "node:fs";
import path from "node:path";
import { runLifecycle } from "./run-lifecycle-core.mjs";
import { sealArtifactSigningRequests } from "./seal-artifact-signing-requests.mjs";
import { sealArtifactSigningControlRequest } from "./artifact-signing-controller-core.mjs";
import { artifactNames, executionResult } from "./artifact-contract.mjs";
import { commonEnv, context, main, readJson, script, sourceRoot, writeJson } from "./context.mjs";

export function lifecycleOptions(plan, platform, stage, root = sourceRoot) {
  const names = artifactNames(plan, platform);
  const directory = `.buildchain/artifacts/${platform.id}`;
  const final = stage === "verify" || stage === "signing-finalization";
  const sampled = plan.build.diagnostics.sample_process_tree;
  return {
    cwd: path.join(root, plan.project.cwd), workspace: root, stageName: stage,
    required: plan.lifecycle[stage]?.required || false, timeoutMinutes: plan.build.timeout_minutes,
    artifactName: names.payload, manifestArtifactName: names.manifest, diagnosticsArtifactName: names.diagnostics,
    platformId: platform.id, platformName: platform.name,
    artifactPaths: [...plan.artifacts.paths.split("\n"), ...(final ? [".buildchain/artifacts/signing"] : [])],
    manifestPath: `${directory}/${final ? "manifest" : `manifest-${stage}`}.json`,
    summaryPath: `${directory}/${final ? "summary" : `summary-${stage}`}.json`,
    expectedArtifactsJson: final ? plan.artifacts.expected_json : "",
    sampleProcessTree: stage === "build" && sampled,
    processSummaryPath: stage !== "install" && sampled ? ".buildchain/diagnostics/process-summary.json" : "",
    processSamplesPath: ".buildchain/diagnostics/process-samples.jsonl",
    processSampleIntervalMs: plan.build.diagnostics.sample_interval_ms,
    requestedParallelism: plan.build.diagnostics.requested_parallelism,
    processSummaryRequired: stage !== "signing-finalization",
    substageEvidencePath: stage === "verify" ? plan.build.verification.substage_evidence_path : "",
  };
}
export function assertStageOrder(stages, stage) {
  const order = ["install", "build", "verify"];
  const index = order.indexOf(stage);
  if (index < 0 || Object.hasOwn(stages, stage)) throw new Error("Invalid or repeated build stage");
  for (const prerequisite of order.slice(0, index)) {
    if (!["success", "not-required"].includes(stages[prerequisite])) throw new Error(`Missing successful ${prerequisite} before ${stage}`);
  }
}
async function sealSigning(plan, platform) {
  const names = artifactNames(plan, platform);
  const requestRoot = `.buildchain/signing/requests/${platform.id}`;
  const index = sealArtifactSigningRequests({ workspace: sourceRoot, cwd: plan.project.cwd,
    manifestPath: `.buildchain/artifacts/${platform.id}/manifest-build.json`, outputRoot: requestRoot,
    repository: plan.run.repository, sourceSha: plan.source.sha, sourceTreeSha: plan.source.tree_sha, runtimeSha: plan.identity.sha, platformId: platform.id });
  sealArtifactSigningControlRequest({ outputPath: `.buildchain/signing/control-requests/${platform.id}/request.json`,
    sourceRepository: plan.run.repository, sourceRunId: plan.run.id, sourceRunAttempt: plan.run.attempt,
    sourceSha: plan.source.sha, sourceTreeSha: plan.source.tree_sha, runtimeRepository: plan.identity.repository,
    runtimeRef: plan.identity.ref, runtimeSha: plan.identity.sha, platformId: platform.id, platformName: platform.name,
    requestCount: index.requests.length, requestArtifact: names.request, requestIndexPath: `${requestRoot}/index.json`,
    authorityRepository: plan.identity.repository, resultArtifact: names.result, artifactName: names.payload,
    manifestArtifact: names.manifest, diagnosticsArtifact: names.diagnostics, workingDirectory: plan.project.cwd });
}
export async function runStage() {
  const { plan, platform } = context();
  const stage = process.env.BUILDCHAIN_STAGE;
  const file = path.join(sourceRoot, `.buildchain/execution/${platform.id}.json`);
  const stages = fs.existsSync(file) ? readJson(file).stages : {};
  assertStageOrder(stages, stage);
  const cache = plan.environment.cache;
  Object.assign(process.env, Object.fromEntries(Object.entries({ ...commonEnv(plan, platform), GITHUB_WORKSPACE: sourceRoot,
    BUILDCHAIN_COMPILER_CACHE_PROVIDER: cache.provider, BUILDCHAIN_COMPILER_CACHE_REQUIRED: cache.required,
    BUILDCHAIN_COMPILER_CACHE_PREPARATION_PATH: ".buildchain/diagnostics/compiler-cache-preparation.json",
    SHIFU_CACHE_PROFILE_REF: cache.profile_ref, SHIFU_CACHE_PROFILE_DIGEST: cache.profile_digest,
    CSC_IDENTITY_AUTO_DISCOVERY: plan.build.macos_signing.app_path ? "false" : "",
    CARGO_REGISTRIES_CRATES_IO_INDEX: plan.environment.tools.cargo_registry_index,
  }).map(([key, value]) => [key, String(value)])));
  process.chdir(sourceRoot);
  try {
    // Derivation can execute project lifecycle commands, so it belongs on the
    // source runner, never in planning with the inventory/control credential.
    if (stage === "install" && plan.anchored_material) {
      await script("packages/core/build/commands/anchored-version-material.mjs", {
        BUILDCHAIN_ANCHORED_SOURCE_CWD: path.join(sourceRoot, plan.project.cwd),
        BUILDCHAIN_ANCHORED_MATERIAL_OUTPUT: `.buildchain/artifacts/${platform.id}/anchored-version-material.json`,
        BUILDCHAIN_ANCHORED_TARGET_CHANNEL: plan.anchored_material.target_channel,
        BUILDCHAIN_ANCHORED_TARGET_REF: plan.anchored_material.target_ref,
        BUILDCHAIN_ANCHORED_RELEASE_REF: "HEAD",
      }, [], { cwd: sourceRoot });
    }
    const usesCache = cache.provider !== "none" && JSON.parse(cache.platforms_json).includes(platform.id);
    if (stage === "build" && usesCache) await script("packages/core/build/commands/compiler-cache-evidence.mjs", {}, ["prepare"], { cwd: sourceRoot });
    runLifecycle(lifecycleOptions(plan, platform, stage));
    if (stage === "build") {
      if (usesCache) await script("packages/core/build/commands/compiler-cache-evidence.mjs", {}, ["verify"], { cwd: sourceRoot });
      await sealSigning(plan, platform);
    }
    if (stage === "verify" && plan.build.macos_signing.app_path && platform.id === plan.build.macos_signing.platform) {
      await script("packages/core/build/commands/seal-macos-credential-input.mjs", { BUILDCHAIN_CREDENTIAL_ISLAND_APP_PATH: path.posix.join(plan.project.cwd, plan.build.macos_signing.app_path),
        BUILDCHAIN_CREDENTIAL_ISLAND_OUTPUT: `.buildchain/credential-island/${platform.id}` }, [], { cwd: sourceRoot });
    }
    if (stage === "verify" && platform.id === "linux-x64" && plan.build.transport_smoke.scenario_path) {
      await script("packages/core/build/commands/auditable-demo-transport-smoke.mjs", {}, ["--artifact-root", plan.build.transport_smoke.artifact_root, "--scenario", plan.build.transport_smoke.scenario_path], { cwd: path.join(sourceRoot, plan.project.cwd) });
    }
    stages[stage] = plan.lifecycle[stage].configured ? "success" : "not-required";
  } catch (error) {
    stages[stage] = "failure";
    throw error;
  } finally { writeJson(file, executionResult(plan, platform, stages)); }
}
main(import.meta.url, runStage);
