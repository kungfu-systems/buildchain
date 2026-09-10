import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { demoActionContext } from "./action-context.js";
import {
  qualifyDemoAdapter,
  renderQualifiedDemo,
} from "./adapter-transactions.js";
export function qualifyDemoAdapterAction(core, env) {
  const request = demoActionContext(core, env);
  if (
    command(
      "git",
      ["-C", path.join(request.workspace, "source"), "rev-parse", "HEAD"],
      { stdio: "pipe" },
    ).trim() !== request.sourceSha
  )
    throw new Error("Demo source differs from exact artifact admission");
  const result = qualifyDemoAdapter({
    ...request,
    adapterPath: core.getInput("adapter-path", { required: true }),
    adapterArgumentsJson: core.getInput("adapter-arguments-json") || "[]",
  });
  core.setOutput("gate-root", result.root);
  core.setOutput("gate-artifact-name", result.artifactName);
}
export function renderQualifiedDemoAction(core, env) {
  const result = renderQualifiedDemo({
    ...demoActionContext(core, env),
    gateRoot: core.getInput("gate-root", { required: true }),
  });
  core.setOutput("media-root", result.root);
  core.setOutput("media-artifact-name", result.artifactName);
  core.setOutput("media-profile", result.mediaProfile);
  core.setOutput("media-qualification-root", result.mediaQualificationRoot);
}
