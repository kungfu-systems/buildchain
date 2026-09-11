import path from "node:path";
import {
  resolvePropagation,
  capturePropagation,
  materializePropagation,
  reconcilePropagation,
} from "./transactions.js";
import { propagationControllerReport } from "./report.js";

function actionContext(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  if (!request || Array.isArray(request) || typeof request !== "object")
    throw new Error("Propagation request must be an object");
  for (const key of ["dry-run", "refresh-managed-readme-badges"])
    if (typeof request[key] !== "boolean")
      throw new Error(`Propagation ${key} must be boolean`);
  if (!path.isAbsolute(env.GITHUB_WORKSPACE || ""))
    throw new Error("Propagation requires the runner workspace");
  return {
    request,
    workspace: env.GITHUB_WORKSPACE,
    summaryPath: env.GITHUB_STEP_SUMMARY,
    source: { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA },
    runtimeRef: core.getInput("runtime-ref"),
    nodePath: core.getInput("node-path"),
    token: core.getInput("token"),
  };
}
const outputs = (core) => (values) => {
  for (const [key, value] of Object.entries(values)) core.setOutput(key, value);
};
export async function resolvePropagationAction(core, env) {
  const target = await resolvePropagation(
    actionContext(core, env),
    outputs(core),
  );
  outputs(core)({
    "propagation-key": target.propagation_key,
    "target-json": JSON.stringify(target),
  });
}
export async function capturePropagationAction(core, env) {
  outputs(core)(await capturePropagation(actionContext(core, env)));
}
export async function materializePropagationAction(core, env) {
  await materializePropagation(actionContext(core, env));
}
export async function reconcilePropagationAction(core, env) {
  await reconcilePropagation(
    actionContext(core, env),
    core.getBooleanInput("predecessors-ok"),
    outputs(core),
  );
}
export function reportPropagationAction(core, env) {
  const { receipt, accepted } = propagationControllerReport(
    actionContext(core, env),
    {
      upload: core.getInput("upload-outcome"),
      workUpload: core.getInput("work-upload-outcome"),
      reconcile: core.getInput("reconcile-outcome"),
      cancelled: core.getBooleanInput("cancelled"),
    },
  );
  outputs(core)({
    "controller-receipt-json": JSON.stringify(receipt),
    "controller-receipt-digest": receipt.digest,
    "controller-receipt-status": receipt.status,
    accepted: String(accepted),
  });
  if (!accepted)
    throw new Error(
      `Release propagation receipt is not qualifying: ${receipt.status}`,
    );
}
