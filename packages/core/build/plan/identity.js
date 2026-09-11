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
