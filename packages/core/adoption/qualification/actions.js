import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { command } from "../../runtime/action-process.mjs";
import { consumerPolicyOutputs } from "../../consumer/policy-scan.js";
import {
  selectAdopter,
  verifyAdopterCheckouts,
  adopterInputFile,
  admitAdopterPolicy,
} from "./admission.js";
import { qualifyAdopterPlatform } from "./platform.js";
import { reconcileAdopterReports } from "./aggregate.js";
function request(core) {
  return JSON.parse(core.getInput("request-json", { required: true }));
}
function coordinates(core, env) {
  return {
    runtimeRoot: installationRoot(import.meta.url),
    consumerRoot: path.join(env.GITHUB_WORKSPACE, ".buildchain/consumer"),
    runtimeSha: core.getInput("workflow-sha", { required: true }),
  };
}
export function selectAdopterAction(core, env) {
  const selected = selectAdopter({
    request: request(core),
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.GITHUB_SHA,
    runtimeSha: core.getInput("workflow-sha", { required: true }),
  });
  for (const [key, value] of Object.entries(selected))
    core.setOutput(key, value);
}
export function admitAdopterPolicyAction(core, env) {
  const input = request(core),
    binding = coordinates(core, env);
  const selected = selectAdopter({
    request: input,
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.GITHUB_SHA,
    runtimeSha: binding.runtimeSha,
  });
  const { result, output } = admitAdopterPolicy({
    ...binding,
    consumerSha: selected.sha,
    repository: selected.repository,
    inputPath: input["input-path"],
    invocationSourcePath:
      input["invocation-source-path"] ||
      (env.GITHUB_REPOSITORY === "kungfu-systems/buildchain"
        ? ".github/workflows/self-build-adopter-dogfood.yml"
        : ""),
  });
  for (const [key, value] of Object.entries(
    consumerPolicyOutputs(result, output),
  ))
    core.setOutput(key, value);
  if (!result.ok)
    throw new Error(
      "Adopter invocation does not satisfy the current public consumer policy",
    );
}
export function qualifyAdopterPlatformAction(core, env) {
  const input = request(core),
    binding = {
      ...coordinates(core, env),
      consumerSha: core.getInput("consumer-sha", { required: true }),
    };
  verifyAdopterCheckouts(binding);
  const platform = core.getInput("platform", { required: true });
  if (
    platform !==
    `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform}-${process.arch}`
  )
    throw new Error("Adopter platform must match the real runner");
  const nodePath = command("node", ["-p", "process.execPath"], {
    cwd: binding.runtimeRoot,
    stdio: "pipe",
  }).trim();
  return qualifyAdopterPlatform({
    ...binding,
    platform,
    consumer: input.consumer,
    inputPath: adopterInputFile(binding.consumerRoot, input["input-path"]),
    output: path.join(
      env.GITHUB_WORKSPACE,
      ".buildchain/adopter-delivery",
      platform,
      "qualification-report.json",
    ),
    nodePath,
    env,
  });
}
export function reconcileAdopterReportsAction(core, env) {
  return reconcileAdopterReports({
    reportsRoot: path.join(
      env.GITHUB_WORKSPACE,
      ".buildchain/platform-reports",
    ),
    consumers: [request(core).consumer],
    output: path.join(
      env.GITHUB_WORKSPACE,
      ".buildchain/adopter-delivery-qualification.json",
    ),
  });
}
