#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
import { gateEnvironment } from "../gate/environment.js";
import { planGateProfiles } from "../gate/plan.js";
import { executeGateProfile } from "../gate/execution.js";
import { aggregateGateProfiles } from "../gate/aggregate.js";
import { gatePlanOutputs, gateExecutionOutputs, gateAggregateOutputs } from "../gate/outputs.js";
export async function shifuGateProfileCli(env = process.env, args = process.argv.slice(2)) {
  const index = args.indexOf("--mode");
  const mode = (index >= 0 ? args[index + 1] : env.BUILDCHAIN_GATE_MODE) || "plan";
  const entry = mode === "run" ? JSON.parse(env.BUILDCHAIN_GATE_MATRIX_ENTRY_JSON || "") : undefined;
  const environment = gateEnvironment({ base: env, shared: JSON.parse(env.BUILDCHAIN_GATE_ENVIRONMENT_JSON || "{}"), platform: entry?.environment,
    cacheProfileRef: env.BUILDCHAIN_SHIFU_CACHE_PROFILE_REF, cacheProfileDigest: env.BUILDCHAIN_SHIFU_CACHE_PROFILE_DIGEST });
  const common = { commandJson: env.BUILDCHAIN_GATE_COMMAND_JSON || '["./shifu"]', registry: env.BUILDCHAIN_GATE_REGISTRY || "",
    cwd: path.resolve(env.BUILDCHAIN_GATE_SOURCE_CWD || process.cwd()), environment };
  if (mode === "plan") {
    const outputRoot = path.resolve(env.BUILDCHAIN_GATE_OUTPUT_ROOT || ".buildchain/gates/plan");
    const matrix = await planGateProfiles({ ...common, outputRoot, profile: env.BUILDCHAIN_GATE_PROFILE || "", includeAdvisory: env.BUILDCHAIN_GATE_INCLUDE_ADVISORY === "true",
      commandJson: env.BUILDCHAIN_GATE_PLAN_COMMAND_JSON || common.commandJson, runnerPreset: env.BUILDCHAIN_RUNNER_PRESET || "github-hosted", platformsJson: env.BUILDCHAIN_PLATFORMS_JSON || "" });
    writeGitHubOutputs(gatePlanOutputs(matrix, path.join(outputRoot, "matrix.json")));
    return matrix;
  }
  if (mode === "run") {
    const result = await executeGateProfile({ ...common, entry, outputRoot: path.resolve(env.BUILDCHAIN_GATE_OUTPUT_ROOT || `.buildchain/gates/executions/${entry.id}`) });
    writeGitHubOutputs(gateExecutionOutputs(result));
    if (!result.qualifying) process.exitCode = 1;
    return result.execution;
  }
  if (mode === "aggregate") {
    const outputPath = path.resolve(env.BUILDCHAIN_GATE_AGGREGATE_PATH || ".buildchain/gates/gate-aggregate.json");
    const aggregate = aggregateGateProfiles({ matrixPath: path.resolve(env.BUILDCHAIN_GATE_MATRIX_PATH || ""), inputRoot: path.resolve(env.BUILDCHAIN_GATE_EXECUTION_INPUT || ""), outputPath, sourceSha: env.BUILDCHAIN_GATE_SOURCE_SHA || "" });
    writeGitHubOutputs(gateAggregateOutputs(aggregate, outputPath));
    if (!aggregate.qualifying) process.exitCode = 1;
    return aggregate;
  }
  throw new Error(`unsupported Shifu gate profile mode: ${mode}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await shifuGateProfileCli(); }
  catch (error) { console.error(`::error::${String(error.message).replace(/\r?\n/g, "%0A")}`); process.exitCode = error.status || 1; }
}
