import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { containedBuildPath } from "../build-configuration.js";
import { prepareGateProfileController } from "./controller.js";
import { gateEnvironment } from "./environment.js";
import { planGateProfiles } from "./plan.js";
import { executeGateProfile } from "./execution.js";
import { aggregateGateProfiles } from "./aggregate.js";
import {
  gatePlanOutputs,
  gateExecutionOutputs,
  gateAggregateOutputs,
} from "./outputs.js";
function outputs(core, values) {
  for (const [name, value] of Object.entries(values))
    core.setOutput(name, value);
}
function environment(request, env, platform) {
  return gateEnvironment({
    base: Object.fromEntries(
      Object.entries(env).filter(([key]) => !key.startsWith("INPUT_")),
    ),
    shared: JSON.parse(request["gate-environment-json"] || "{}"),
    platform,
    cacheProfileRef: request["shifu-cache-profile-ref"],
    cacheProfileDigest: request["shifu-cache-profile-digest"],
  });
}
export async function planGateProfilesAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const admitted = prepareGateProfileController({
    workspace,
    runtimeRoot: installationRoot(import.meta.url),
    runtimeSha: core.getInput("runtime-sha", { required: true }),
    runtimeRef: core.getInput("runtime-ref", { required: true }),
    repository: env.GITHUB_REPOSITORY,
    request,
  });
  outputs(core, {
    "source-sha": admitted.sourceSha,
    "controller-plan-json": admitted.controller,
    "controller-plan-digest": admitted.controller.digest,
    "controller-plan-artifact": `${request["artifact-name"]}-controller-plan-${admitted.sourceSha}`,
    "gate-matrix-artifact": `${request["artifact-name"]}-matrix-${admitted.sourceSha}`,
  });
  const outputRoot = path.join(workspace, ".buildchain/gates/plan");
  const matrix = await planGateProfiles({
    profile: request["gate-profile"],
    includeAdvisory: request["include-advisory"] === true,
    commandJson:
      request["gate-plan-command-json"] || request["gate-command-json"],
    registry: request["gate-registry"],
    cwd: admitted.cwd,
    outputRoot,
    environment: environment(request, env),
    runnerPreset: request["runner-preset"],
    platformsJson: request["platforms-json"],
  });
  outputs(core, gatePlanOutputs(matrix, path.join(outputRoot, "matrix.json")));
}
export async function executeGateProfileAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const entry = JSON.parse(core.getInput("entry-json", { required: true }));
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const result = await executeGateProfile({
    entry,
    commandJson: request["gate-command-json"],
    registry: request["gate-registry"],
    cwd: containedBuildPath(
      path.join(workspace, "source"),
      request["working-directory"] || ".",
    ),
    outputRoot: containedBuildPath(
      workspace,
      `.buildchain/gates/executions/${entry.id}`,
    ),
    environment: environment(request, env, entry.environment),
  });
  outputs(core, gateExecutionOutputs(result));
  if (!result.qualifying)
    throw new Error("Shifu Gate execution did not qualify");
}
export function aggregateGateProfilesAction(core, env) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const outputPath = path.join(
    workspace,
    ".buildchain/gates/gate-aggregate.json",
  );
  const aggregate = aggregateGateProfiles({
    matrixPath: path.join(workspace, ".buildchain/gates/plan/matrix.json"),
    inputRoot: path.join(workspace, ".buildchain/gates/downloaded-executions"),
    outputPath,
    sourceSha: core.getInput("source-sha", { required: true }),
  });
  outputs(core, gateAggregateOutputs(aggregate, outputPath));
  if (!aggregate.qualifying)
    throw new Error("Shifu Gate aggregate did not qualify");
}
