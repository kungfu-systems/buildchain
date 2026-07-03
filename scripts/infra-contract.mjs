#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyInfraContract,
  createInfraContractArtifact,
  createInfraContractPlan,
  createInfraContractPropagationPlan,
  validateInfraContractProject,
} from "./infra-contract-core.mjs";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || "";
}

function readBooleanArg(name, fallback = true) {
  const value = readArg(name, "");
  if (!value) {
    return fallback;
  }
  return value === "true" || value === "1";
}

function writeJson(result, outputPath) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, json);
  } else {
    process.stdout.write(json);
  }
}

function readJsonFileArg(name) {
  const value = readArg(name, "");
  if (!value) {
    return null;
  }
  return JSON.parse(fs.readFileSync(path.resolve(value), "utf8"));
}

export function infraContractCli() {
  const mode = readArg("mode", process.env.BUILDCHAIN_INFRA_CONTRACT_MODE || "validate");
  const cwd = readArg("cwd", process.env.BUILDCHAIN_WORKDIR || process.cwd());
  const sourceSha = readArg("source-sha", process.env.BUILDCHAIN_SOURCE_SHA || process.env.GITHUB_SHA || "");
  const output = readArg("output", process.env.BUILDCHAIN_INFRA_CONTRACT_OUTPUT || "");

  if (mode === "validate") {
    const result = validateInfraContractProject(cwd);
    writeJson(result, output);
    writeGitHubOutputs({
      "project-type": result.project?.type || "",
      "infra-adapter": result.infra?.adapter || "",
      "infra-adoption-mode": result.infra?.adoptionMode || "",
      "infra-apply-mode": result.infra?.applyMode || "",
    });
    return result;
  }

  if (mode === "plan") {
    const result = createInfraContractPlan({ cwd, sourceSha });
    writeJson(result, output);
    writeGitHubOutputs({
      "infra-plan-hash": result.planHash,
      "infra-plan-json": JSON.stringify(result),
    });
    return result;
  }

  if (mode === "contract") {
    const plan = readJsonFileArg("plan");
    const result = createInfraContractArtifact({
      cwd,
      sourceSha,
      plan,
      approvedBy: readArg("approved-by", process.env.GITHUB_ACTOR || ""),
      approvalId: readArg("approval-id", ""),
      applyRunId: readArg("apply-run-id", process.env.GITHUB_RUN_ID || ""),
      rollbackPointer: readArg("rollback-pointer", process.env.BUILDCHAIN_ROLLBACK_REF || ""),
    });
    writeJson(result, output);
    writeGitHubOutputs({
      "infra-contract-hash": result.artifactHash,
      "infra-contract-json": JSON.stringify(result),
    });
    return result;
  }

  if (mode === "propagation-plan") {
    const artifact = readJsonFileArg("artifact");
    const result = createInfraContractPropagationPlan({
      cwd,
      artifact,
      branchPrefix: readArg("branch-prefix", "buildchain/infra-contract"),
    });
    writeJson(result, output);
    writeGitHubOutputs({
      "infra-propagation-count": String(result.pullRequests.length),
      "infra-propagation-plan-json": JSON.stringify(result),
    });
    return result;
  }

  if (mode === "apply") {
    const result = applyInfraContract({
      cwd,
      sourceSha,
      approvalId: readArg("approval-id", ""),
      dryRun: readBooleanArg("dry-run", true),
    });
    writeJson(result, output);
    writeGitHubOutputs({
      "infra-apply-status": result.status,
      "infra-apply-result-json": JSON.stringify(result),
    });
    return result;
  }

  throw new Error(`unsupported infra-contract mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    infraContractCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
