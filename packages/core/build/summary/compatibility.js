import { rootOf } from "../plan/values.js";

export function qualifyHistoricalBuild(conclusion, value) {
  if (conclusion !== "success")
    throw new Error(`Build did not qualify: ${conclusion || "missing"}`);
  const result = typeof value === "string" ? JSON.parse(value) : value;
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Missing rooted build result");
  const { root, ...body } = result;
  if (
    result.schema !== "buildchain.build-result/v1" ||
    result.status !== "success" ||
    root !== rootOf(body)
  )
    throw new Error("Build result failed its contract or content root");
  return result;
}

export function qualifyHistoricalBuildAction(core) {
  qualifyHistoricalBuild(
    core.getInput("conclusion", { required: true }),
    core.getInput("result", { required: true }),
  );
}
