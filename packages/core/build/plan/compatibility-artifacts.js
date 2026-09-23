import { containedBuildPath } from "../build-configuration.js";
import path from "node:path";

export function historicalBuildArtifacts(plan, inputs, root) {
  const remaining = { ...inputs };
  const fields = {
    "artifact-name": "name",
    "artifact-name-template": "name_template",
    "expected-artifacts-json": "expected_json",
  };
  for (const [input, field] of Object.entries(fields)) {
    if (!Object.hasOwn(remaining, input)) continue;
    plan.artifacts[field] = remaining[input];
    delete remaining[input];
  }
  plan.build.artifacts.name = plan.artifacts.name;
  if (Object.hasOwn(remaining, "artifact-paths")) {
    const paths = remaining["artifact-paths"]
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .filter(Boolean);
    plan.build.artifacts.paths = paths;
    plan.artifacts.paths = paths
      .map((item) => {
        const relative = path.posix.join(plan.project.cwd, item);
        containedBuildPath(root, relative);
        return relative;
      })
      .join("\n");
    delete remaining["artifact-paths"];
  }
  const expected = JSON.parse(plan.artifacts.expected_json);
  if (!expected || typeof expected !== "object" || Array.isArray(expected))
    throw new Error("expected-artifacts-json must describe artifact checks");
  for (const field of ["minFiles", "maxFiles", "minTotalBytes"])
    if (
      expected[field] !== undefined &&
      (!Number.isSafeInteger(expected[field]) || expected[field] < 0)
    )
      throw new Error(`Invalid artifact check: ${field}`);
  if (expected.requiredPaths !== undefined) {
    if (!Array.isArray(expected.requiredPaths))
      throw new Error("requiredPaths must be an array");
    for (const item of expected.requiredPaths) containedBuildPath(root, item);
  }
  return remaining;
}
