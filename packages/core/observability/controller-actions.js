import path from "node:path";
import {
  planControllerEvidence,
  receiptControllerEvidence,
} from "./controller-evidence-io.js";

function jsonInput(core, name, fallback) {
  try {
    return JSON.parse(core.getInput(name) || JSON.stringify(fallback));
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

export function controllerPlanAction(core) {
  const outputPath = path.resolve(core.getInput("plan-path"));
  const plan = planControllerEvidence({
    registryPath: core.getInput("registry"),
    outputPath,
    controllerId: core.getInput("controller-id", { required: true }),
    source: {
      repository: core.getInput("source-repository", { required: true }),
      sha: core.getInput("source-sha", { required: true }),
    },
    runtime: {
      ref: core.getInput("runtime-ref", { required: true }),
      sha: core.getInput("runtime-sha", { required: true }),
      contractDigest: core.getInput("contract-digest", { required: true }),
    },
    inputs: jsonInput(core, "inputs-json", {}),
    inputBoundary: core.getInput("input-boundary"),
  });
  for (const [key, value] of Object.entries({
    "controller-plan-path": outputPath,
    "controller-plan-json": JSON.stringify(plan),
    "controller-plan-digest": plan.digest,
  }))
    core.setOutput(key, value);
}

export function controllerReceiptAction(core) {
  const outputPath = path.resolve(core.getInput("receipt-path"));
  const code = core.getInput("reason-code");
  const receipt = receiptControllerEvidence({
    planPath: core.getInput("plan-path"),
    outputPath,
    stages: jsonInput(core, "stages-json", []),
    evidence: jsonInput(core, "evidence-json", []),
    evidenceFiles: jsonInput(core, "evidence-files-json", []),
    artifact: core.getInput("artifact"),
    reason: code
      ? { code, summary: core.getInput("reason-summary") }
      : undefined,
  });
  for (const [key, value] of Object.entries({
    "controller-receipt-path": outputPath,
    "controller-receipt-json": JSON.stringify(receipt),
    "controller-receipt-digest": receipt.digest,
    "controller-receipt-status": receipt.status,
    "controller-receipt-qualifying": String(receipt.qualifying),
  }))
    core.setOutput(key, value);
}
