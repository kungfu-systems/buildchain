import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveBuildConfiguration } from "./configuration.js";
import { admitBuildSource } from "./admission.js";
import { resolveBuildReleaseSource } from "./source.js";
import { resolveBuildRunners } from "./runners.js";
import { planControllerEvidence } from "../../observability/controller-evidence-io.js";
import { rootOf, writeJson } from "./values.js";

export async function resolveBuildPlan(request, providers) {
  const {
    workspace,
    sourceRoot,
    runtimeRoot,
    configPath,
    workflow,
    source,
    event,
    run,
  } = request;
  if (
    event.name === "pull_request" &&
    event.payload.pull_request?.head?.repo?.full_name !== run.repository
  )
    throw new Error("Untrusted source cannot reach build runners");
  const { plan } = resolveBuildConfiguration({
    root: sourceRoot,
    locator: configPath,
    workflowRef: workflow.ref,
    workflowSha: workflow.sha,
    repository: "kungfu-systems/buildchain",
    sourceSha: source.sha,
    sourceRef: source.ref,
    callerWorkflowRef: workflow.callerRef,
    eventName: event.name,
    baseRef: source.baseRef,
  });
  const git = (...args) =>
    execFileSync("git", ["-C", sourceRoot, ...args], {
      encoding: "utf8",
    }).trim();
  if (git("rev-parse", "HEAD") !== plan.source.sha)
    throw new Error("Checked out source differs from invocation");
  plan.source.tree_sha = git("rev-parse", "HEAD^{tree}");
  plan.run = { ...run };
  plan.admission = await admitBuildSource(
    { plan, sourceRoot, runtimeRoot, workspace, workflow },
    providers,
  );
  const releaseSource = await resolveBuildReleaseSource(
    { plan, sourceRoot, workspace, source },
    providers.channel,
  );
  plan.source.release = releaseSource.release;
  plan.anchored_material = releaseSource.anchoredMaterial;
  Object.assign(
    plan,
    await resolveBuildRunners(plan, providers.runnerInventory),
  );
  plan.controller = planControllerEvidence({
    registryPath: path.join(runtimeRoot, "dist/site/controller-registry.json"),
    outputPath: path.join(workspace, ".buildchain/plan/controller.json"),
    controllerId: "build-lifecycle",
    inputBoundary: "strict",
    source: { repository: run.repository, sha: plan.source.sha },
    runtime: {
      ref: plan.identity.ref,
      sha: plan.identity.sha,
      contractDigest: plan.admission.contract_digest,
    },
    inputs: { "configuration-root": plan.configuration_root },
  });
  plan.root = rootOf(plan);
  writeJson(path.join(workspace, ".buildchain/plan/plan.json"), plan);
  return plan;
}
