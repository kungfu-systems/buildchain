import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createControllerPlan,
  createControllerReceipt,
} from "./controller-evidence.js";
import {
  selectWorkflowCallInputs,
  resolveControllerInputBoundary,
} from "./controller-input-boundary.js";

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label}: ${error.message}`);
  }
}
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

export function planControllerEvidence({
  registryPath,
  outputPath,
  controllerId,
  source,
  runtime,
  inputs = {},
  inputBoundary = "",
}) {
  const registry = readJson(registryPath, "controller registry");
  const descriptor = registry.controllers?.find(
    (entry) => entry.id === controllerId,
  );
  if (!descriptor)
    throw new Error(`controller registry does not declare ${controllerId}`);
  const boundary = resolveControllerInputBoundary(descriptor, inputBoundary);
  const plan = createControllerPlan({
    descriptor,
    source,
    runtime,
    inputs:
      boundary === "workflow-call"
        ? selectWorkflowCallInputs(descriptor, inputs)
        : inputs,
  });
  writeJson(outputPath, plan);
  return plan;
}

export function collectControllerEvidence(evidence, files) {
  if (!Array.isArray(evidence) || !Array.isArray(files))
    throw new Error("controller evidence inputs must be arrays");
  return [
    ...evidence,
    ...files.map((entry, index) => {
      if (!entry.kind || !entry.path)
        throw new Error(
          `controller evidence file ${index} requires kind and path`,
        );
      const filePath = path.resolve(String(entry.path));
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile())
        throw new Error(`controller evidence file is missing: ${entry.path}`);
      return {
        kind: String(entry.kind),
        digest: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`,
        ...(entry.artifact ? { artifact: String(entry.artifact) } : {}),
      };
    }),
  ];
}

export function receiptControllerEvidence({
  planPath,
  outputPath,
  stages,
  evidence = [],
  evidenceFiles = [],
  reason,
  artifact,
}) {
  if (!Array.isArray(stages))
    throw new Error("controller stages JSON must be an array");
  const normalize = (value) => {
    const status = String(value || "")
      .trim()
      .toLowerCase();
    return (
      {
        success: "passed",
        failure: "failed",
        cancelled: "cancelled",
        skipped: "skipped",
      }[status] || status
    );
  };
  const receipt = createControllerReceipt({
    plan: readJson(planPath, "controller plan"),
    stages: stages.map((stage) => ({
      ...stage,
      status: normalize(stage.status),
    })),
    evidence: collectControllerEvidence(evidence, evidenceFiles),
    reason,
    artifact,
  });
  writeJson(outputPath, receipt);
  return receipt;
}
