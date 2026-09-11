#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { planControllerEvidence, receiptControllerEvidence } from "../controller-evidence-io.js";
import {
  validateControllerPlan,
  validateControllerReceipt,
} from "../controller-evidence.js";

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

function writeOutputs(outputs) {
  const outputPath = env("GITHUB_OUTPUT");
  if (!outputPath) return;
  fs.appendFileSync(outputPath, Object.entries(outputs).map(([name, value]) => `${name}=${String(value ?? "")}\n`).join(""));
}

function planMode() {
  const registryPath = path.resolve(env("BUILDCHAIN_CONTROLLER_REGISTRY", ".buildchain/runtime/dist/site/controller-registry.json"));
  const outputPath = path.resolve(env("BUILDCHAIN_CONTROLLER_PLAN_PATH", ".buildchain/controller/plan.json"));
  const plan = planControllerEvidence({
    registryPath, outputPath, controllerId: env("BUILDCHAIN_CONTROLLER_ID"),
    inputs: parseJson(env("BUILDCHAIN_CONTROLLER_INPUTS_JSON", "{}"), "controller inputs JSON", {}),
    inputBoundary: env("BUILDCHAIN_CONTROLLER_INPUT_BOUNDARY"),
    source: { repository: env("BUILDCHAIN_CONTROLLER_SOURCE_REPOSITORY"), sha: env("BUILDCHAIN_CONTROLLER_SOURCE_SHA") },
    runtime: { ref: env("BUILDCHAIN_CONTROLLER_RUNTIME_REF"), sha: env("BUILDCHAIN_CONTROLLER_RUNTIME_SHA"), contractDigest: env("BUILDCHAIN_CONTROLLER_CONTRACT_DIGEST") },
  });
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
  const outputPath = path.resolve(env("BUILDCHAIN_CONTROLLER_RECEIPT_PATH", ".buildchain/controller/receipt.json"));
  const receipt = receiptControllerEvidence({ planPath, outputPath, stages,
    evidence: parseJson(env("BUILDCHAIN_CONTROLLER_EVIDENCE_JSON", "[]"), "controller evidence JSON", []),
    evidenceFiles: parseJson(env("BUILDCHAIN_CONTROLLER_EVIDENCE_FILES_JSON", "[]"), "controller evidence files JSON", []),
    reason: env("BUILDCHAIN_CONTROLLER_REASON_CODE") ? {
      code: env("BUILDCHAIN_CONTROLLER_REASON_CODE"), summary: env("BUILDCHAIN_CONTROLLER_REASON_SUMMARY", "controller did not pass"),
    } : undefined,
    artifact: env("BUILDCHAIN_CONTROLLER_RECEIPT_ARTIFACT"),
  });
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
