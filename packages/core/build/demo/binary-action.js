import fs from "node:fs";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { sourceSha } from "../standalone/identity.js";
import { buildStandaloneBinary } from "../standalone/build.js";
import { runTransportSmoke } from "./transport-smoke.js";
export function prepareDemoBinaryAction(core, env) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  if (
    fs.realpathSync(installationRoot(import.meta.url)) !==
      fs.realpathSync(workspace) ||
    sourceSha(workspace) !== env.GITHUB_SHA
  )
    throw new Error(
      "Demo binary must be built from the exact checked-out source",
    );
  buildStandaloneBinary({
    cwd: workspace,
    outputDir: "dist/auditable-demo-binary",
  });
  runTransportSmoke({
    artifactRoot: path.join(workspace, "dist/auditable-demo-binary"),
    scenarioPath: path.join(workspace, ".buildchain/auditable-demo.json"),
  });
  core.setOutput(
    "name",
    `buildchain-auditable-demo-binary-${env.GITHUB_SHA.slice(0, 12)}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  );
}
