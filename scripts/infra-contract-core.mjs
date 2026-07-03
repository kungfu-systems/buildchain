import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadBuildchainConfig, validateBuildchainConfig } from "../packages/core/buildchain-config.js";

const PLAN_CONTRACT = "kungfu-buildchain-infra-contract-plan";
const ARTIFACT_CONTRACT = "kungfu-buildchain-infra-contract";
const PROPAGATION_CONTRACT = "kungfu-buildchain-infra-contract-propagation-plan";

const STATIC_CAPABILITIES = Object.freeze({
  "manual-observed": { validate: true, plan: false, apply: false, observe: true },
  "aws-cloudformation": { validate: true, plan: true, apply: true, observe: true },
  terraform: { validate: true, plan: true, apply: true, observe: true },
  opentofu: { validate: true, plan: true, apply: true, observe: true },
  pulumi: { validate: true, plan: true, apply: true, observe: true },
  "aws-cdk": { validate: true, plan: true, apply: true, observe: true },
  "aws-cli": { validate: true, plan: true, apply: true, observe: true },
});

function assertInfraContractConfig(loadedConfig) {
  if (loadedConfig?.config?.project?.type !== "infra-contract") {
    throw new Error('buildchain.toml project.type must be "infra-contract"');
  }
  return loadedConfig.config;
}

function assertSha(value, label) {
  const sha = String(value || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return sha.toLowerCase();
}

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function sha256Buffer(value) {
  const hash = crypto.createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}

function stableJson(value) {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function assertSafeInfraPath(rel) {
  const normalized = toPosix(rel);
  if (normalized.startsWith("../") || path.isAbsolute(normalized)) {
    throw new Error(`infra-contract path must stay inside the repository: ${rel}`);
  }
  if (/\.(tfstate|tfstate\.backup)$/i.test(normalized)) {
    throw new Error(`infra-contract must not read Terraform/OpenTofu state files: ${rel}`);
  }
  if (/pulumi\..*\.json$/i.test(path.basename(normalized))) {
    throw new Error(`infra-contract must not read Pulumi state or secrets files: ${rel}`);
  }
  return normalized;
}

function readFileRecord(cwd, rel) {
  const safeRel = assertSafeInfraPath(rel);
  const filePath = path.join(cwd, safeRel);
  if (!fs.existsSync(filePath)) {
    throw new Error(`infra-contract file does not exist: ${safeRel}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`infra-contract path must be a file: ${safeRel}`);
  }
  const source = fs.readFileSync(filePath);
  let json;
  if (safeRel.endsWith(".json")) {
    json = JSON.parse(source.toString("utf8"));
  }
  return {
    path: safeRel,
    size: stat.size,
    sha256: sha256Buffer(source),
    json,
  };
}

function configuredFileRecords(cwd, entries) {
  return entries.map((entry) => readFileRecord(cwd, entry));
}

function adapterCapabilities(config) {
  if (config.infra.adapter !== "custom-command") {
    return STATIC_CAPABILITIES[config.infra.adapter];
  }
  const commands = config.infra.commands || {};
  return {
    validate: Boolean(commands.validate),
    plan: Boolean(commands.plan),
    apply: Boolean(commands.apply),
    observe: Boolean(commands.observe),
  };
}

function stageStatuses({ config, capabilities, planHash = "" }) {
  return {
    desired: { status: "declared" },
    validate: { status: capabilities.validate ? "ready" : "unsupported" },
    plan: { status: capabilities.plan ? "ready" : "static-contract" },
    approval: {
      status: config.infra.applyMode === "disabled" ? "not-required" : "required",
      mode: config.infra.applyMode,
    },
    apply: {
      status: config.infra.applyMode === "disabled" ? "disabled" : (capabilities.apply ? "gated" : "unsupported"),
    },
    observe: { status: capabilities.observe ? "ready" : "unsupported" },
    contract: { status: planHash ? "ready" : "planned" },
    propagate: { status: config.consumers.length > 0 ? "ready" : "missing-consumers" },
  };
}

export function validateInfraContractProject(cwd = process.cwd()) {
  const summary = validateBuildchainConfig(cwd, {
    requireConfig: true,
  });
  if (summary.project?.type !== "infra-contract") {
    throw new Error('buildchain.toml project.type must be "infra-contract"');
  }
  return summary;
}

export function createInfraContractPlan({
  cwd = process.cwd(),
  sourceSha = "",
  plannedAt = new Date().toISOString(),
} = {}) {
  const loadedConfig = loadBuildchainConfig(cwd);
  const config = assertInfraContractConfig(loadedConfig);
  const desiredFiles = configuredFileRecords(cwd, config.infra.desired);
  const contractFiles = configuredFileRecords(cwd, config.infra.contract);
  const capabilities = adapterCapabilities(config);
  const consumerContracts = config.consumers.map((consumer) => ({
    ...consumer,
    sourceFile: readFileRecord(cwd, consumer.source),
  }));
  const base = {
    schemaVersion: 1,
    contract: PLAN_CONTRACT,
    project: {
      name: config.project.name || "",
      type: config.project.type,
    },
    sourceSha: assertSha(sourceSha, "sourceSha"),
    plannedAt,
    adapter: config.infra.adapter,
    adoptionMode: config.infra.adoptionMode,
    applyMode: config.infra.applyMode,
    environment: config.infra.environment,
    mutationAllowed: false,
    desiredFiles: desiredFiles.map(({ json, ...entry }) => entry),
    contractFiles: contractFiles.map(({ json, ...entry }) => entry),
    consumers: consumerContracts.map((consumer) => ({
      repo: consumer.repo,
      path: consumer.path,
      source: consumer.source,
      branch: consumer.branch,
      sourceSha256: consumer.sourceFile.sha256,
    })),
    adapterCapabilities: capabilities,
    requiredApprovals: config.infra.applyMode === "disabled" ? [] : [config.infra.applyMode],
    issues: [],
  };
  const planHash = sha256Buffer(stableJson(base));
  return {
    ...base,
    planHash,
    stages: stageStatuses({ config, capabilities, planHash }),
  };
}

export function createInfraContractArtifact({
  cwd = process.cwd(),
  sourceSha = "",
  plan,
  approvedBy = "",
  approvalId = "",
  applyRunId = "",
  observedAt = new Date().toISOString(),
  rollbackPointer = "",
} = {}) {
  const loadedConfig = loadBuildchainConfig(cwd);
  const config = assertInfraContractConfig(loadedConfig);
  const selectedPlan = plan || createInfraContractPlan({ cwd, sourceSha, plannedAt: observedAt });
  if (selectedPlan.contract !== PLAN_CONTRACT) {
    throw new Error("infra-contract artifact requires an infra-contract plan");
  }
  const normalizedContractFiles = configuredFileRecords(cwd, config.infra.contract);
  const artifactBase = {
    schemaVersion: 1,
    contract: ARTIFACT_CONTRACT,
    project: selectedPlan.project,
    sourceSha: selectedPlan.sourceSha,
    adapter: config.infra.adapter,
    adoptionMode: config.infra.adoptionMode,
    applyMode: config.infra.applyMode,
    environment: config.infra.environment,
    desiredFiles: selectedPlan.desiredFiles,
    plan: {
      hash: selectedPlan.planHash,
      contract: selectedPlan.contract,
    },
    approval: {
      required: config.infra.applyMode !== "disabled",
      id: approvalId,
      actor: approvedBy,
    },
    apply: {
      enabled: config.infra.applyMode !== "disabled",
      runId: applyRunId,
    },
    observed: {
      observedAt,
      source: config.infra.adapter === "manual-observed" ? "reviewed-contract-files" : "adapter-observe",
      files: normalizedContractFiles.map(({ path: filePath, size, sha256, json }) => ({
        path: filePath,
        size,
        sha256,
        outputs: json?.outputs || json || {},
      })),
    },
    consumers: selectedPlan.consumers,
    rollbackPointer,
    validation: {
      mutationFree: true,
      desiredAndObservedSeparated: true,
      secretRefs: config.infra.secretRefs,
    },
  };
  return {
    ...artifactBase,
    artifactHash: sha256Buffer(stableJson(artifactBase)),
  };
}

export function createInfraContractPropagationPlan({
  cwd = process.cwd(),
  artifact,
  branchPrefix = "buildchain/infra-contract",
} = {}) {
  const selectedArtifact = artifact || createInfraContractArtifact({ cwd, sourceSha: "0".repeat(40) });
  if (selectedArtifact.contract !== ARTIFACT_CONTRACT) {
    throw new Error("infra-contract propagation requires an infra-contract artifact");
  }
  return {
    schemaVersion: 1,
    contract: PROPAGATION_CONTRACT,
    sourceSha: selectedArtifact.sourceSha,
    artifactHash: selectedArtifact.artifactHash,
    mutationAllowed: false,
    pullRequests: selectedArtifact.consumers.map((consumer) => ({
      repo: consumer.repo,
      branch: `${branchPrefix}/${selectedArtifact.artifactHash.slice(0, 12)}`,
      path: consumer.path,
      source: consumer.source,
      title: "chore(infra): update Buildchain infra contract",
      body: `Update ${consumer.path} from Buildchain infra contract ${selectedArtifact.artifactHash}.`,
    })),
  };
}

export function applyInfraContract({
  cwd = process.cwd(),
  sourceSha = "",
  approvalId = "",
  dryRun = true,
} = {}) {
  const loadedConfig = loadBuildchainConfig(cwd);
  const config = assertInfraContractConfig(loadedConfig);
  const capabilities = adapterCapabilities(config);
  if (config.infra.applyMode === "disabled") {
    throw new Error("infra-contract apply is disabled by config");
  }
  if (!capabilities.apply) {
    throw new Error(`infra adapter ${config.infra.adapter} does not support apply`);
  }
  if (!approvalId) {
    throw new Error("infra-contract apply requires an approval id before mutation");
  }
  const plan = createInfraContractPlan({ cwd, sourceSha });
  if (dryRun) {
    return {
      schemaVersion: 1,
      contract: "kungfu-buildchain-infra-contract-apply",
      status: "planned",
      dryRun: true,
      approvalId,
      planHash: plan.planHash,
      mutationExecuted: false,
    };
  }
  throw new Error("infra-contract apply execution is not implemented for adapters yet");
}
