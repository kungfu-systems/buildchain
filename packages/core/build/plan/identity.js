import fs from "node:fs";
import { containedBuildPath } from "../build-configuration.js";
import { rootOf } from "./values.js";
export function assertPlan(plan) {
  const { root, ...body } = plan;
  if (plan.schema !== "buildchain.build-plan/v1" || root !== rootOf(body))
    throw new Error("Build plan root mismatch");
  for (const sha of [
    plan.source.sha,
    plan.source.tree_sha,
  ]) {
    if (!/^[a-f0-9]{40}$/u.test(sha))
      throw new Error(
        "Build plan requires exact source and tree identities",
      );
  }
  if (
    !Array.isArray(plan.platforms) ||
    !plan.platforms.length ||
    new Set(plan.platforms.map((p) => p.id)).size !== plan.platforms.length
  ) {
    throw new Error("Build plan must declare unique platforms");
  }
  return plan;
}

export function bindBuildPlan({
  plan,
  run,
  platformId = "",
  workspace,
}) {
  assertPlan(plan);
  if (
    plan.run.id !== run.id ||
    plan.run.repository !== run.repository ||
    plan.run.attempt !== run.attempt
  )
    throw new Error("Build plan belongs to another run");
  const platform = platformId
    ? plan.platforms.find((item) => item.id === platformId)
    : null;
  if (platformId && !platform)
    throw new Error("Platform is not in the build plan");
  if (!workspace) throw new Error("Build workspace is required");
  return { plan, platform, workspace };
}

export function resolveBuildIdentity({ root, workflowRef, workflowSha, repository, callerWorkflowRef }) {
  const match = String(workflowRef).match(
    /^([^/]+\/[^/]+)\/(\.github\/workflows\/[^@]+)@(?:refs\/(?:heads|tags)\/)?(v([1-9]\d*)(-alpha)?)$/u,
  );
  if (!match || match[1] !== repository)
    throw new Error(
      "Ordinary builds require the exact called workflow identity on a floating channel",
    );
  const identity = {
    repository,
    ref: match[3],
    full_ref: `refs/tags/${match[3]}`,
    sha: workflowSha,
    channel: match[5] ? "alpha" : "stable",
    major: match[4],
    visible_workflow: match[2],
  };
  const callerPath = callerWorkflowRef
    .split("@")[0]
    .split("/.github/workflows/")[1];
  if (callerPath) {
    const caller = fs.readFileSync(
      containedBuildPath(root, `.github/workflows/${callerPath}`),
      "utf8",
    );
    const calls = [
      ...caller.matchAll(
        /uses:\s+kungfu-systems\/buildchain\/(\.github\/workflows\/(?:build|\.build)\.yml)@(v\d+(?:-alpha)?)\s*$/gmu,
      ),
    ].filter((call) => call[2] === identity.ref);
    const paths = [...new Set(calls.map((call) => call[1]))];
    if (paths.length !== 1)
      throw new Error(
        "Unable to derive one visible build workflow from the exact caller",
      );
    identity.visible_workflow = paths[0];
  }
  return identity;
}
