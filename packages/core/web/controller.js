import fs from "node:fs";
import path from "node:path";
import {
  planControllerEvidence,
  receiptControllerEvidence,
} from "../observability/controller-evidence-io.js";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export function initializeWebController({
  workspace,
  runtimeRoot,
  request,
  runtime,
  source,
}) {
  const contract = read(
    path.join(runtimeRoot, "dist/site/buildchain-contract.json"),
  );
  return planControllerEvidence({
    registryPath: path.join(runtimeRoot, "dist/site/controller-registry.json"),
    outputPath: path.join(workspace, ".buildchain/controller/plan.json"),
    controllerId: "web-surface",
    source,
    runtime: {
      ref: runtime["runtime-ref"],
      sha: runtime["runtime-sha"],
      contractDigest: contract.contractDigest,
    },
    inputs: request,
    inputBoundary: "workflow-call",
  });
}

export function webPlanApplicable(observations) {
  const plan = observations.plan;
  return (
    plan?.result === "success" &&
    Boolean(
      plan.outputs?.["web-surface-channel"] ||
      plan.outputs?.["web-surface-cleanup-plan-json"],
    )
  );
}

function aggregate(results) {
  for (const result of ["failure", "cancelled", "success"])
    if (results.includes(result)) return result;
  return "skipped";
}

export function webControllerStages(observations, prepublication = false) {
  const result = (job) => observations[job]?.result || "skipped";
  const plan = observations.plan?.outputs || {};
  const apply = [
    "preview-apply",
    "preview-cleanup",
    "staging-apply",
    "production-apply",
  ].map(result);
  return [
    { id: "resolve-runtime", status: result("execution-runtime") },
    { id: "plan", status: result("plan") },
    { id: "build", status: plan["build-outcome"] || result("plan") },
    { id: "verify", status: plan["verify-outcome"] || result("plan") },
    {
      id: "publication-authority",
      status: prepublication
        ? "skipped"
        : aggregate([
            result("publication-authority"),
            result("external-publication-authority"),
          ]),
    },
    { id: "apply", status: prepublication ? "skipped" : aggregate(apply) },
    {
      id: "aggregate",
      status: prepublication
        ? "success"
        : aggregate([result("plan"), ...apply]),
    },
  ];
}

export function selectWebControllerPlan(
  directory,
  { production = false } = {},
) {
  const candidates = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith("-plan.json"))
    .sort();
  if (
    candidates.length !== 1 ||
    (production && candidates[0] !== "web-surface-production-plan.json")
  )
    throw new Error(
      `Expected exactly one ${production ? "production " : ""}Web plan; found ${candidates.join(", ") || "none"}`,
    );
  const source = path.join(directory, candidates[0]);
  if (!fs.lstatSync(source).isFile())
    throw new Error("Web plan evidence must be a regular file");
  return source;
}

export function finalizeWebController({
  workspace,
  observations,
  sourceSha,
  prepublication = false,
}) {
  const directory = path.join(workspace, ".buildchain/controller");
  const applicable = prepublication || webPlanApplicable(observations);
  const evidenceFiles = [];
  if (applicable) {
    const source = selectWebControllerPlan(path.join(directory, "web-plans"), {
      production: prepublication,
    });
    const destination = path.join(directory, "web-surface-plan.json");
    fs.copyFileSync(source, destination);
    evidenceFiles.push({ kind: "web-surface-plan", path: destination });
  }
  const incomplete = observations.plan?.result !== "success";
  const receipt = receiptControllerEvidence({
    planPath: path.join(directory, "plan.json"),
    outputPath: path.join(directory, "receipt.json"),
    stages: webControllerStages(observations, prepublication),
    evidenceFiles,
    artifact: `buildchain-web-surface-${prepublication ? "prepublication" : "controller"}-receipt-${sourceSha}`,
    ...(!prepublication && (incomplete || !applicable)
      ? {
          reason: {
            code: incomplete
              ? "web-surface-incomplete"
              : "no-applicable-web-surface-channel",
            summary:
              "Web-surface controller did not complete an applicable channel successfully",
          },
        }
      : {}),
  });
  return {
    receipt,
    requireQualifying: prepublication || incomplete || applicable,
  };
}
