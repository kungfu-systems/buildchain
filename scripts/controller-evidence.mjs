#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createControllerPlan,
  createControllerReceipt,
  validateControllerPlan,
  validateControllerReceipt,
} from "../packages/core/controller-evidence.js";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || "";
}

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function readJson(filePath, label = filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label}: ${error.message}`);
  }
}

function parseJson(value, label, fallback = undefined) {
  if (!String(value || "").trim() && fallback !== undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeOutputs(outputs) {
  const outputPath = env("GITHUB_OUTPUT");
  if (!outputPath) return;
  fs.appendFileSync(outputPath, Object.entries(outputs).map(([name, value]) => `${name}=${String(value ?? "")}\n`).join(""));
}

function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function descriptorFromRegistry(registry, controllerId) {
  const descriptor = registry.controllers?.find((entry) => entry.id === controllerId);
  if (!descriptor) throw new Error(`controller registry does not declare ${controllerId}`);
  return descriptor;
}

export function selectWorkflowCallInputs(descriptor, inputs) {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new Error("controller inputs JSON must be an object");
  }
  const declaredInputs = descriptor?.inputs;
  if (!declaredInputs || typeof declaredInputs !== "object" || Array.isArray(declaredInputs)) {
    throw new Error("controller descriptor inputs must be an object");
  }
  return Object.fromEntries(
    Object.entries(inputs).filter(([name]) => Object.hasOwn(declaredInputs, name)),
  );
}

function normalizeStageStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return {
    success: "passed",
    failure: "failed",
    cancelled: "cancelled",
    skipped: "skipped",
  }[normalized] || normalized;
}

function collectEvidence() {
  const inline = parseJson(env("BUILDCHAIN_CONTROLLER_EVIDENCE_JSON", "[]"), "controller evidence JSON", []);
  const files = parseJson(env("BUILDCHAIN_CONTROLLER_EVIDENCE_FILES_JSON", "[]"), "controller evidence files JSON", []);
  if (!Array.isArray(inline) || !Array.isArray(files)) throw new Error("controller evidence inputs must be arrays");
  return [
    ...inline,
    ...files.map((entry, index) => {
      const filePath = path.resolve(String(entry.path || ""));
      if (!entry.kind || !entry.path) throw new Error(`controller evidence file ${index} requires kind and path`);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`controller evidence file is missing: ${entry.path}`);
      return {
        kind: String(entry.kind),
        digest: sha256File(filePath),
        ...(entry.artifact ? { artifact: String(entry.artifact) } : {}),
      };
    }),
  ];
}

function planMode() {
  const registryPath = path.resolve(env("BUILDCHAIN_CONTROLLER_REGISTRY", ".buildchain/runtime/dist/site/controller-registry.json"));
  const registry = readJson(registryPath, "controller registry");
  const descriptor = descriptorFromRegistry(registry, env("BUILDCHAIN_CONTROLLER_ID"));
  const rawInputs = parseJson(env("BUILDCHAIN_CONTROLLER_INPUTS_JSON", "{}"), "controller inputs JSON", {});
  const inputBoundary = env("BUILDCHAIN_CONTROLLER_INPUT_BOUNDARY", "strict");
  if (!["strict", "workflow-call"].includes(inputBoundary)) {
    throw new Error(`unsupported controller input boundary: ${inputBoundary}`);
  }
  const plan = createControllerPlan({
    descriptor,
    source: {
      repository: env("BUILDCHAIN_CONTROLLER_SOURCE_REPOSITORY"),
      sha: env("BUILDCHAIN_CONTROLLER_SOURCE_SHA"),
    },
    runtime: {
      ref: env("BUILDCHAIN_CONTROLLER_RUNTIME_REF"),
      sha: env("BUILDCHAIN_CONTROLLER_RUNTIME_SHA"),
      contractDigest: env("BUILDCHAIN_CONTROLLER_CONTRACT_DIGEST"),
    },
    inputs: inputBoundary === "workflow-call"
      ? selectWorkflowCallInputs(descriptor, rawInputs)
      : rawInputs,
  });
  const outputPath = path.resolve(env("BUILDCHAIN_CONTROLLER_PLAN_PATH", ".buildchain/controller/plan.json"));
  writeJson(outputPath, plan);
  writeOutputs({
    "controller-plan-path": outputPath,
    "controller-plan-json": JSON.stringify(plan),
    "controller-plan-digest": plan.digest,
  });
  return plan;
}

function receiptMode() {
  const planPath = path.resolve(env("BUILDCHAIN_CONTROLLER_PLAN_PATH", ".buildchain/controller/plan.json"));
  const stages = parseJson(env("BUILDCHAIN_CONTROLLER_STAGES_JSON", "[]"), "controller stages JSON", []);
  if (!Array.isArray(stages)) throw new Error("controller stages JSON must be an array");
  const receipt = createControllerReceipt({
    plan: readJson(planPath, "controller plan"),
    stages: stages.map((stage) => ({ ...stage, status: normalizeStageStatus(stage.status) })),
    evidence: collectEvidence(),
    reason: env("BUILDCHAIN_CONTROLLER_REASON_CODE")
      ? {
          code: env("BUILDCHAIN_CONTROLLER_REASON_CODE"),
          summary: env("BUILDCHAIN_CONTROLLER_REASON_SUMMARY", "controller did not pass"),
        }
      : undefined,
    artifact: env("BUILDCHAIN_CONTROLLER_RECEIPT_ARTIFACT"),
  });
  const outputPath = path.resolve(env("BUILDCHAIN_CONTROLLER_RECEIPT_PATH", ".buildchain/controller/receipt.json"));
  writeJson(outputPath, receipt);
  writeOutputs({
    "controller-receipt-path": outputPath,
    "controller-receipt-json": JSON.stringify(receipt),
    "controller-receipt-digest": receipt.digest,
    "controller-receipt-status": receipt.status,
    "controller-receipt-qualifying": String(receipt.qualifying),
  });
  return receipt;
}

function validateMode() {
  const kind = env("BUILDCHAIN_CONTROLLER_EVIDENCE_KIND", argument("kind", "receipt"));
  const filePath = path.resolve(env("BUILDCHAIN_CONTROLLER_EVIDENCE_PATH", argument("file")));
  const value = readJson(filePath, `controller ${kind}`);
  const validation = kind === "plan" ? validateControllerPlan(value) : validateControllerReceipt(value);
  if (!validation.ok || (process.argv.includes("--require-qualifying") && !validation.qualifying)) {
    throw new Error(`controller ${kind} validation failed: ${validation.issues.join("; ") || "not qualifying"}`);
  }
  return validation;
}

export function controllerEvidenceCli() {
  const mode = argument("mode", env("BUILDCHAIN_CONTROLLER_MODE", "plan"));
  if (mode === "plan") return planMode();
  if (mode === "receipt") return receiptMode();
  if (mode === "validate") return validateMode();
  throw new Error(`unsupported controller evidence mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    controllerEvidenceCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
