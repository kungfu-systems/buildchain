import path from "node:path";
import { sourceSha } from "../standalone/identity.js";
import { buildStandaloneBinary } from "../standalone/build.js";
import { runTransportSmoke } from "./transport-smoke.js";
export function prepareDemoBinaryAction(
  core,
  env,
  { build = buildStandaloneBinary, smoke = runTransportSmoke } = {},
) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  if (sourceSha(workspace) !== env.GITHUB_SHA)
    throw new Error(
      "Demo binary must be built from the exact checked-out source",
    );
  build({
    cwd: workspace,
    outputDir: "dist/auditable-demo-binary",
  });
  smoke({
    artifactRoot: path.join(workspace, "dist/auditable-demo-binary"),
    scenarioPath: path.join(workspace, ".buildchain/auditable-demo.json"),
  });
  core.setOutput(
    "name",
    `buildchain-auditable-demo-binary-${env.GITHUB_SHA.slice(0, 12)}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  );
}
