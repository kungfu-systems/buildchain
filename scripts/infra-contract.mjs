#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyInfraContract,
  applyInfraContractPropagation,
  createInfraContractArtifact,
  createInfraContractEvidenceBundle,
  createInfraContractPlan,
  createInfraContractPropagationPlan,
  validateInfraContractProject,
  verifyInfraContractEvidenceBundle,
} from "./infra-contract-core.mjs";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

const INFRA_CONTRACT_CI_CONTRACT = "kungfu-buildchain-infra-contract-ci";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || "";
}

function readRepeatedArg(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

function readBooleanArg(name, fallback = true) {
  const value = readArg(name, "");
  if (!value) {
    return fallback;
  }
  return value === "true" || value === "1";
}

function readNumberArg(name, fallback) {
  const value = readArg(name, "");
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} must be a number`);
  }
  return parsed;
}

function readNumberEnv(name, fallback) {
  const value = process.env[name] || "";
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
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

function writeJsonFile(result, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`);
  return filePath;
}

function posixRelative(cwd, filePath) {
  return path.relative(cwd, filePath).split(path.sep).join("/");
}

function readJsonFileArg(name) {
  const value = readArg(name, "");
  if (!value) {
    return null;
  }
  return JSON.parse(fs.readFileSync(path.resolve(value), "utf8"));
}

function readKeyValueMapArg(name) {
  const entries = {};
  for (const value of readRepeatedArg(name)) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new Error(`--${name} must use key=value`);
    }
    entries[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return entries;
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

  if (mode === "ci") {
    const outputDir = path.resolve(cwd, readArg("output-dir", process.env.BUILDCHAIN_INFRA_CONTRACT_OUTPUT_DIR || ".buildchain"));
    const files = {
      validation: path.join(outputDir, "infra-contract-validate.json"),
      plan: path.join(outputDir, "infra-contract-plan.json"),
      artifact: path.join(outputDir, "buildchain.infra-contract.json"),
      propagationPlan: path.join(outputDir, "infra-contract-propagation.json"),
      propagationResult: path.join(outputDir, "infra-contract-propagation-apply.json"),
      applyResult: path.join(outputDir, "infra-contract-apply.json"),
      evidenceBundle: path.join(outputDir, "infra-contract-evidence-bundle.json"),
      verification: path.join(outputDir, "infra-contract-evidence-verification.json"),
    };
    const validation = validateInfraContractProject(cwd);
    writeJsonFile(validation, files.validation);
    const executeAdapterCommands = readBooleanArg("execute-adapter-commands", false);
    const plan = createInfraContractPlan({
      cwd,
      sourceSha,
      executeAdapterCommands,
    });
    writeJsonFile(plan, files.plan);
    const artifact = createInfraContractArtifact({
      cwd,
      sourceSha,
      plan,
      approvedBy: readArg("approved-by", process.env.GITHUB_ACTOR || ""),
      approvalId: readArg("approval-id", ""),
      applyRunId: readArg("apply-run-id", process.env.GITHUB_RUN_ID || ""),
      rollbackPointer: readArg("rollback-pointer", process.env.BUILDCHAIN_ROLLBACK_REF || ""),
      executeAdapterCommands,
    });
    writeJsonFile(artifact, files.artifact);
    const propagationPlan = createInfraContractPropagationPlan({
      cwd,
      artifact,
      branchPrefix: readArg("branch-prefix", "buildchain/infra-contract"),
    });
    writeJsonFile(propagationPlan, files.propagationPlan);
    const propagationResult = (artifact.consumers || []).length > 0
      ? applyInfraContractPropagation({
        cwd,
        artifact,
        propagationPlan,
        dryRun: true,
      })
      : null;
    if (propagationResult) {
      writeJsonFile(propagationResult, files.propagationResult);
    }
    let applyResult = null;
    if (artifact.apply?.enabled) {
      const approvalId = readArg("approval-id", "");
      if (!approvalId) {
        throw new Error("infra-contract ci requires --approval-id for apply-enabled contracts");
      }
      applyResult = applyInfraContract({
        cwd,
        sourceSha,
        approvalId,
        dryRun: true,
        plan,
        planMaxAgeMinutes: readNumberArg(
          "plan-max-age-minutes",
          readNumberEnv("BUILDCHAIN_INFRA_CONTRACT_PLAN_MAX_AGE_MINUTES", 60),
        ),
      });
      writeJsonFile(applyResult, files.applyResult);
    }
    const evidenceBundle = createInfraContractEvidenceBundle({
      artifact,
      applyResult,
      propagationResult,
    });
    writeJsonFile(evidenceBundle, files.evidenceBundle);
    const verification = verifyInfraContractEvidenceBundle(evidenceBundle);
    writeJsonFile(verification, files.verification);
    if (!verification.ok) {
      throw new Error(`infra-contract ci evidence verification failed: ${verification.issues.map((issue) => issue.code).join(", ")}`);
    }
    const result = {
      schemaVersion: 1,
      contract: INFRA_CONTRACT_CI_CONTRACT,
      cwd,
      sourceSha,
      artifactHash: artifact.artifactHash,
      evidenceBundleHash: evidenceBundle.bundleHash,
      verificationOk: verification.ok,
      mutationAllowed: false,
      mutationExecuted: false,
      propagationPlanned: Boolean(propagationResult),
      files: Object.fromEntries(
        Object.entries(files)
          .filter(([, filePath]) => fs.existsSync(filePath))
          .map(([key, filePath]) => [key, posixRelative(cwd, filePath)]),
      ),
    };
    writeJson(result, output);
    writeGitHubOutputs({
      "infra-contract-hash": artifact.artifactHash,
      "infra-evidence-bundle-hash": evidenceBundle.bundleHash,
      "infra-evidence-verification-ok": String(verification.ok),
      "infra-ci-json": JSON.stringify(result),
    });
    return result;
  }

  if (mode === "plan") {
    const result = createInfraContractPlan({
      cwd,
      sourceSha,
      executeAdapterCommands: readBooleanArg("execute-adapter-commands", false),
    });
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
      executeAdapterCommands: readBooleanArg("execute-adapter-commands", false),
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

  if (mode === "propagation-apply") {
    const result = applyInfraContractPropagation({
      cwd,
      artifact: readJsonFileArg("artifact"),
      propagationPlan: readJsonFileArg("propagation-plan"),
      dryRun: readBooleanArg("dry-run", true),
      approvalId: readArg("approval-id", ""),
      consumerWorkspaces: readKeyValueMapArg("consumer-workspace"),
    });
    writeJson(result, output);
    writeGitHubOutputs({
      "infra-propagation-status": result.status,
      "infra-propagation-result-json": JSON.stringify(result),
    });
    return result;
  }

  if (mode === "evidence-bundle") {
    const result = createInfraContractEvidenceBundle({
      artifact: readJsonFileArg("artifact"),
      applyResult: readJsonFileArg("apply-result"),
      propagationResult: readJsonFileArg("propagation-result"),
    });
    writeJson(result, output);
    writeGitHubOutputs({
      "infra-evidence-bundle-hash": result.bundleHash,
      "infra-evidence-bundle-json": JSON.stringify(result),
    });
    return result;
  }

  if (mode === "apply") {
    const result = applyInfraContract({
      cwd,
      sourceSha,
      approvalId: readArg("approval-id", ""),
      dryRun: readBooleanArg("dry-run", true),
      plan: readJsonFileArg("plan"),
      planMaxAgeMinutes: readNumberArg(
        "plan-max-age-minutes",
        readNumberEnv("BUILDCHAIN_INFRA_CONTRACT_PLAN_MAX_AGE_MINUTES", 60),
      ),
      executeAdapterCommands: readBooleanArg("execute-adapter-commands", false),
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
