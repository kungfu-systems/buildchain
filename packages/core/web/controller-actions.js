import path from "node:path";
import { installationRoot } from "../runtime/installation-root.js";
import {
  initializeWebController,
  finalizeWebController,
} from "./controller.js";

export function initializeWebControllerAction(core, env) {
  const runtime = JSON.parse(core.getInput("runtime-json", { required: true }));
  const intent = JSON.parse(core.getInput("intent-json", { required: true }));
  const plan = initializeWebController({
    workspace: env.GITHUB_WORKSPACE,
    runtimeRoot: installationRoot(import.meta.url),
    request: JSON.parse(core.getInput("request-json", { required: true })),
    runtime,
    source: {
      repository: env.GITHUB_REPOSITORY,
      sha: intent["production-source-sha"],
    },
  });
  core.setOutput("controller-plan-json", JSON.stringify(plan));
  core.setOutput("controller-plan-digest", plan.digest);
}

export function finalizeWebControllerAction(core, env) {
  const observations = JSON.parse(
    core.getInput("observations-json", { required: true }),
  );
  const { receipt, requireQualifying } = finalizeWebController({
    workspace: env.GITHUB_WORKSPACE,
    observations,
    sourceSha: observations["release-intent"].outputs["production-source-sha"],
  });
  core.setOutput("controller-receipt-json", JSON.stringify(receipt));
  core.setOutput("controller-receipt-digest", receipt.digest);
  core.setOutput("controller-receipt-status", receipt.status);
  core.setOutput(
    "controller-receipt-path",
    path.join(env.GITHUB_WORKSPACE, ".buildchain/controller/receipt.json"),
  );
  if (requireQualifying && !receipt.qualifying)
    throw new Error(
      `Web controller receipt is not qualifying: ${receipt.status}`,
    );
}
