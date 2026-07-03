import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadBuildchainConfig, validateBuildchainConfig } from "../packages/core/buildchain-config.js";

const PLAN_CONTRACT = "kungfu-buildchain-infra-contract-plan";
const ARTIFACT_CONTRACT = "kungfu-buildchain-infra-contract";
const PROPAGATION_CONTRACT = "kungfu-buildchain-infra-contract-propagation-plan";
const PROPAGATION_APPLY_CONTRACT = "kungfu-buildchain-infra-contract-propagation-apply";
const APPLY_CONTRACT = "kungfu-buildchain-infra-contract-apply";
const EVIDENCE_BUNDLE_CONTRACT = "kungfu-buildchain-infra-contract-evidence-bundle";

const STATIC_CAPABILITIES = Object.freeze({
  "manual-observed": { validate: true, plan: false, apply: false, observe: true },
  "aws-cloudformation": { validate: true, plan: true, apply: true, observe: true },
  terraform: { validate: true, plan: true, apply: true, observe: true },
  opentofu: { validate: true, plan: true, apply: true, observe: true },
  pulumi: { validate: true, plan: true, apply: true, observe: true },
  "aws-cdk": { validate: true, plan: true, apply: true, observe: true },
  "aws-cli": { validate: true, plan: true, apply: true, observe: true },
});

const STATIC_ADAPTER_COMMANDS = Object.freeze({
  "aws-cloudformation": {
    validate: ({ desiredFile }) => `aws cloudformation validate-template --template-body file://${desiredFile}`,
    plan: ({ desiredFile }) => `aws cloudformation create-change-set --stack-name <stack-name> --change-set-name <change-set-name> --change-set-type UPDATE --template-body file://${desiredFile}`,
    apply: () => "aws cloudformation execute-change-set --stack-name <stack-name> --change-set-name <change-set-name>",
    observe: () => "aws cloudformation describe-stacks --stack-name <stack-name> --query 'Stacks[0].Outputs' --output json",
  },
  terraform: {
    validate: () => "terraform validate -no-color",
    plan: () => "terraform plan -input=false -out=.buildchain/infra-contract/terraform.tfplan",
    apply: () => "terraform apply -input=false .buildchain/infra-contract/terraform.tfplan",
    observe: () => "terraform output -json",
  },
  opentofu: {
    validate: () => "tofu validate -no-color",
    plan: () => "tofu plan -input=false -out=.buildchain/infra-contract/opentofu.tfplan",
    apply: () => "tofu apply -input=false .buildchain/infra-contract/opentofu.tfplan",
    observe: () => "tofu output -json",
  },
  pulumi: {
    validate: () => "pulumi preview --json",
    plan: () => "pulumi preview --json",
    apply: () => "pulumi up --yes --json",
    observe: () => "pulumi stack output --json",
  },
  "aws-cdk": {
    validate: () => "npx cdk synth",
    plan: () => "npx cdk diff",
    apply: () => "npx cdk deploy --require-approval never",
    observe: () => "aws cloudformation describe-stacks --stack-name <cdk-stack-name> --query 'Stacks[0].Outputs' --output json",
  },
  "aws-cli": {
    validate: () => "aws <service> <validate-operation> --cli-input-json file://<desired-file>",
    plan: () => "aws <service> <plan-or-dry-run-operation> --cli-input-json file://<desired-file>",
    apply: () => "aws <service> <apply-operation> --cli-input-json file://<approved-plan>",
    observe: () => "aws <service> <describe-operation> --output json",
  },
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

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    input: options.input,
    encoding: "utf8",
  });
  return {
    command,
    args,
    cwd: options.cwd || process.cwd(),
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function runShellCommand(command, options = {}) {
  const shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : (process.env.SHELL || "/bin/sh");
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  return runCommand(shell, args, options);
}

function assertCommandSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result;
}

function parseOptionalJson(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function redactCommandText(value) {
  return String(value || "").replace(/(token|secret|password|passwd|key)=\S+/gi, "$1=<redacted>");
}

function adapterCommandTemplate({ config, stage }) {
  const configuredCommand = config.infra.commands?.[stage];
  if (configuredCommand) {
    return {
      command: configuredCommand,
      commandSource: "configured",
      executable: true,
    };
  }
  const adapterCommands = STATIC_ADAPTER_COMMANDS[config.infra.adapter];
  const commandFactory = adapterCommands?.[stage];
  if (!commandFactory) {
    return null;
  }
  return {
    command: commandFactory({
      desiredFile: config.infra.desired[0] || "<desired-file>",
      contractFile: config.infra.contract[0] || "<contract-file>",
    }),
    commandSource: "builtin-plan",
    executable: false,
  };
}

function collectAdapterEvidence({ cwd, config, stages, executeAdapterCommands, runner = runShellCommand }) {
  return stages
    .map((stage) => [stage, adapterCommandTemplate({ config, stage })])
    .filter(([, template]) => template)
    .map(([stageName, template]) => {
      const command = template.command;
      const willExecute = Boolean(executeAdapterCommands && template.executable);
      const base = {
        stage: stageName,
        adapter: config.infra.adapter,
        commandSource: template.commandSource,
        command: redactCommandText(command),
        executable: template.executable,
        executed: willExecute,
        status: willExecute ? "pending" : "planned",
        exitCode: null,
        stdout: "",
        stderr: "",
        output: undefined,
      };
      if (!willExecute) {
        return base;
      }
      const result = runner(command, { cwd });
      return {
        ...base,
        status: result.status === 0 ? "passed" : "failed",
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        output: parseOptionalJson(result.stdout),
      };
    });
}

function assertAdapterEvidencePassed(evidence) {
  const failed = evidence.find((entry) => entry.executed && entry.status !== "passed");
  if (failed) {
    throw new Error(`infra adapter ${failed.stage} command failed: ${failed.stderr || failed.stdout || `exit ${failed.exitCode}`}`);
  }
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

function createPlanInputFingerprint({ config, sourceSha, desiredFiles, contractFiles, consumerContracts, capabilities }) {
  return sha256Buffer(stableJson({
    project: {
      name: config.project.name || "",
      type: config.project.type,
    },
    sourceSha,
    adapter: config.infra.adapter,
    adoptionMode: config.infra.adoptionMode,
    applyMode: config.infra.applyMode,
    environment: config.infra.environment,
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
  }));
}

function assertInfraContractPlan(plan) {
  if (!plan || typeof plan !== "object" || plan.contract !== PLAN_CONTRACT) {
    throw new Error("infra-contract apply requires a saved infra-contract plan");
  }
  if (!plan.planHash || typeof plan.planHash !== "string") {
    throw new Error("infra-contract apply plan is missing planHash");
  }
  return plan;
}

function assertInfraContractPropagationPlan(plan) {
  if (!plan || typeof plan !== "object" || plan.contract !== PROPAGATION_CONTRACT) {
    throw new Error("infra-contract propagation apply requires a saved propagation plan");
  }
  if (!plan.artifactHash || typeof plan.artifactHash !== "string") {
    throw new Error("infra-contract propagation plan is missing artifactHash");
  }
  return plan;
}

function assertInfraContractArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || artifact.contract !== ARTIFACT_CONTRACT) {
    throw new Error("infra-contract evidence bundle requires a saved infra-contract artifact");
  }
  if (!artifact.artifactHash || typeof artifact.artifactHash !== "string") {
    throw new Error("infra-contract artifact is missing artifactHash");
  }
  const { artifactHash, ...artifactBase } = artifact;
  const computedHash = sha256Buffer(stableJson(artifactBase));
  if (computedHash !== artifactHash) {
    throw new Error("infra-contract artifactHash does not match artifact contents");
  }
  return artifact;
}

function assertInfraContractApplyResult({ artifact, applyResult }) {
  if (!artifact.apply?.enabled) {
    if (applyResult) {
      throw new Error("infra-contract apply result was provided but apply is disabled in the artifact");
    }
    return null;
  }
  if (!applyResult || typeof applyResult !== "object" || applyResult.contract !== APPLY_CONTRACT) {
    throw new Error("infra-contract evidence bundle requires a saved apply result when apply is enabled");
  }
  if (applyResult.sourceSha && applyResult.sourceSha !== artifact.sourceSha) {
    throw new Error("infra-contract apply result sourceSha does not match the artifact");
  }
  if (applyResult.planHash !== artifact.plan?.hash) {
    throw new Error("infra-contract apply result planHash does not match the artifact plan");
  }
  return applyResult;
}

function assertInfraContractPropagationResult({ artifact, propagationResult }) {
  if ((artifact.consumers || []).length === 0) {
    if (propagationResult) {
      throw new Error("infra-contract propagation result was provided but the artifact has no consumers");
    }
    return null;
  }
  if (!propagationResult || typeof propagationResult !== "object" || propagationResult.contract !== PROPAGATION_APPLY_CONTRACT) {
    throw new Error("infra-contract evidence bundle requires a saved propagation apply result when consumers are configured");
  }
  if (propagationResult.artifactHash !== artifact.artifactHash) {
    throw new Error("infra-contract propagation result artifactHash does not match the artifact");
  }
  return propagationResult;
}

function assertFreshApplyPlan({ cwd, plan, sourceSha, now, planMaxAgeMinutes }) {
  const selectedPlan = assertInfraContractPlan(plan);
  const expectedSourceSha = assertSha(sourceSha || selectedPlan.sourceSha, "sourceSha");
  if (selectedPlan.sourceSha !== expectedSourceSha) {
    throw new Error(`infra-contract apply sourceSha mismatch: plan has ${selectedPlan.sourceSha}, expected ${expectedSourceSha}`);
  }
  const plannedAtMs = Date.parse(selectedPlan.plannedAt || "");
  if (!Number.isFinite(plannedAtMs)) {
    throw new Error("infra-contract apply plan is missing a valid plannedAt timestamp");
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error("infra-contract apply requires a valid current timestamp");
  }
  const maxAgeMs = Number(planMaxAgeMinutes) * 60 * 1000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("infra-contract apply plan max age must be a positive number of minutes");
  }
  const ageMs = nowMs - plannedAtMs;
  if (ageMs < -5 * 60 * 1000) {
    throw new Error("infra-contract apply plan timestamp is in the future");
  }
  if (ageMs > maxAgeMs) {
    throw new Error(`infra-contract apply plan is stale: plannedAt ${selectedPlan.plannedAt} exceeds ${planMaxAgeMinutes} minute limit`);
  }
  const currentPlan = createInfraContractPlan({
    cwd,
    sourceSha: expectedSourceSha,
    plannedAt: selectedPlan.plannedAt,
  });
  const selectedInputHash = selectedPlan.inputHash || selectedPlan.planHash;
  const currentInputHash = selectedPlan.inputHash ? currentPlan.inputHash : currentPlan.planHash;
  if (currentInputHash !== selectedInputHash) {
    throw new Error("infra-contract apply plan no longer matches current desired, contract, or consumer inputs");
  }
  return {
    plan: selectedPlan,
    sourceSha: expectedSourceSha,
    inputHash: currentInputHash,
    ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
    planMaxAgeMinutes: Number(planMaxAgeMinutes),
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
  executeAdapterCommands = false,
  commandRunner = runShellCommand,
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
  const selectedSourceSha = assertSha(sourceSha, "sourceSha");
  const inputHash = createPlanInputFingerprint({
    config,
    sourceSha: selectedSourceSha,
    desiredFiles,
    contractFiles,
    consumerContracts,
    capabilities,
  });
  const adapterEvidence = collectAdapterEvidence({
    cwd,
    config,
    stages: ["validate", "plan"],
    executeAdapterCommands,
    runner: commandRunner,
  });
  assertAdapterEvidencePassed(adapterEvidence);
  const base = {
    schemaVersion: 1,
    contract: PLAN_CONTRACT,
    project: {
      name: config.project.name || "",
      type: config.project.type,
    },
    sourceSha: selectedSourceSha,
    plannedAt,
    inputHash,
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
    adapterEvidence,
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
  executeAdapterCommands = false,
  commandRunner = runShellCommand,
} = {}) {
  const loadedConfig = loadBuildchainConfig(cwd);
  const config = assertInfraContractConfig(loadedConfig);
  const selectedPlan = plan || createInfraContractPlan({ cwd, sourceSha, plannedAt: observedAt });
  if (selectedPlan.contract !== PLAN_CONTRACT) {
    throw new Error("infra-contract artifact requires an infra-contract plan");
  }
  const adapterEvidence = collectAdapterEvidence({
    cwd,
    config,
    stages: ["observe"],
    executeAdapterCommands,
    runner: commandRunner,
  });
  assertAdapterEvidencePassed(adapterEvidence);
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
      adapterEvidence,
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
      sourceSha256: consumer.sourceSha256,
      baseBranch: consumer.branch || "main",
      title: "chore(infra): update Buildchain infra contract",
      body: `Update ${consumer.path} from Buildchain infra contract ${selectedArtifact.artifactHash}.`,
    })),
  };
}

export function createInfraContractEvidenceBundle({
  artifact,
  applyResult,
  propagationResult,
  createdAt = new Date().toISOString(),
} = {}) {
  const selectedArtifact = assertInfraContractArtifact(artifact);
  const selectedApplyResult = assertInfraContractApplyResult({
    artifact: selectedArtifact,
    applyResult,
  });
  const selectedPropagationResult = assertInfraContractPropagationResult({
    artifact: selectedArtifact,
    propagationResult,
  });
  const bundleBase = {
    schemaVersion: 1,
    contract: EVIDENCE_BUNDLE_CONTRACT,
    createdAt,
    sourceSha: selectedArtifact.sourceSha,
    artifactHash: selectedArtifact.artifactHash,
    lifecycle: {
      desired: {
        files: selectedArtifact.desiredFiles,
      },
      plan: selectedArtifact.plan,
      approval: selectedArtifact.approval,
      apply: {
        required: Boolean(selectedArtifact.apply?.enabled),
        runId: selectedArtifact.apply?.runId || "",
        result: selectedApplyResult,
      },
      observe: selectedArtifact.observed,
      contract: {
        hash: selectedArtifact.artifactHash,
        artifact: selectedArtifact,
      },
      propagate: {
        required: (selectedArtifact.consumers || []).length > 0,
        consumers: selectedArtifact.consumers || [],
        result: selectedPropagationResult,
      },
    },
    validation: {
      artifactHashVerified: true,
      applyResultBound: selectedArtifact.apply?.enabled ? Boolean(selectedApplyResult) : true,
      propagationResultBound: (selectedArtifact.consumers || []).length > 0 ? Boolean(selectedPropagationResult) : true,
      mutationExecuted: Boolean(selectedApplyResult?.mutationExecuted),
      propagationExecuted: Boolean(selectedPropagationResult?.mutationExecuted),
    },
  };
  return {
    ...bundleBase,
    bundleHash: sha256Buffer(stableJson(bundleBase)),
  };
}

export function applyInfraContractPropagation({
  cwd = process.cwd(),
  artifact,
  propagationPlan,
  dryRun = true,
  approvalId = "",
  consumerWorkspaces = {},
  runner = runCommand,
} = {}) {
  const selectedPlan = assertInfraContractPropagationPlan(
    propagationPlan || createInfraContractPropagationPlan({ cwd, artifact }),
  );
  if (artifact && artifact.contract !== ARTIFACT_CONTRACT) {
    throw new Error("infra-contract propagation apply requires an infra-contract artifact");
  }
  if (artifact && artifact.artifactHash !== selectedPlan.artifactHash) {
    throw new Error("infra-contract propagation plan artifactHash does not match the artifact");
  }
  if (!dryRun && !approvalId) {
    throw new Error("infra-contract propagation apply requires an approval id before opening consumer PRs");
  }

  const operations = selectedPlan.pullRequests.map((request) => {
    const sourceRecord = readFileRecord(cwd, request.source);
    if (request.sourceSha256 && request.sourceSha256 !== sourceRecord.sha256) {
      throw new Error(`infra-contract propagation source drifted for ${request.source}`);
    }
    const workspace = consumerWorkspaces[request.repo] || "";
    const targetPath = assertSafeInfraPath(request.path);
    const operation = {
      repo: request.repo,
      branch: request.branch,
      baseBranch: request.baseBranch || "main",
      path: targetPath,
      source: request.source,
      sourceSha256: sourceRecord.sha256,
      workspace,
      title: request.title,
      body: request.body,
      status: dryRun ? "planned" : "pending",
      executed: false,
      pullRequestUrl: "",
      commands: [
        ["git", "-C", workspace || "<consumer-workspace>", "checkout", "-B", request.branch],
        ["git", "-C", workspace || "<consumer-workspace>", "add", targetPath],
        ["git", "-C", workspace || "<consumer-workspace>", "commit", "-m", request.title],
        ["git", "-C", workspace || "<consumer-workspace>", "push", "-u", "origin", request.branch],
        ["gh", "pr", "create", "--repo", request.repo, "--base", request.baseBranch || "main", "--head", request.branch],
      ],
    };

    if (dryRun) {
      return operation;
    }

    if (!workspace) {
      throw new Error(`infra-contract propagation apply requires --consumer-workspace for ${request.repo}`);
    }
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
      throw new Error(`infra-contract consumer workspace does not exist: ${workspace}`);
    }
    const status = assertCommandSuccess(runner("git", ["-C", workspace, "status", "--porcelain"]), `${request.repo} status`);
    if (status.stdout.trim()) {
      throw new Error(`infra-contract consumer workspace must be clean before propagation: ${request.repo}`);
    }
    assertCommandSuccess(runner("git", ["-C", workspace, "checkout", "-B", request.branch]), `${request.repo} branch`);
    const targetFile = path.join(workspace, targetPath);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(path.join(cwd, assertSafeInfraPath(request.source)), targetFile);
    assertCommandSuccess(runner("git", ["-C", workspace, "add", targetPath]), `${request.repo} add`);
    const diff = runner("git", ["-C", workspace, "diff", "--cached", "--quiet"]);
    if (diff.status === 0) {
      return {
        ...operation,
        status: "unchanged",
        executed: true,
      };
    }
    if (diff.status !== 1) {
      throw new Error(`${request.repo} diff failed: ${diff.stderr || diff.stdout || `exit ${diff.status}`}`);
    }
    assertCommandSuccess(runner("git", ["-C", workspace, "commit", "-m", request.title, "-m", request.body]), `${request.repo} commit`);
    assertCommandSuccess(runner("git", ["-C", workspace, "push", "-u", "origin", request.branch]), `${request.repo} push`);
    const pr = assertCommandSuccess(
      runner("gh", [
        "pr",
        "create",
        "--repo",
        request.repo,
        "--base",
        request.baseBranch || "main",
        "--head",
        request.branch,
        "--title",
        request.title,
        "--body",
        request.body,
      ]),
      `${request.repo} pr create`,
    );
    return {
      ...operation,
      status: "opened",
      executed: true,
      pullRequestUrl: pr.stdout.trim(),
    };
  });

  return {
    schemaVersion: 1,
    contract: PROPAGATION_APPLY_CONTRACT,
    artifactHash: selectedPlan.artifactHash,
    dryRun,
    approvalId,
    mutationAllowed: !dryRun,
    mutationExecuted: !dryRun && operations.some((operation) => operation.executed),
    status: dryRun ? "planned" : "completed",
    operations,
  };
}

export function applyInfraContract({
  cwd = process.cwd(),
  sourceSha = "",
  approvalId = "",
  dryRun = true,
  plan,
  now = new Date().toISOString(),
  planMaxAgeMinutes = 60,
  executeAdapterCommands = false,
  commandRunner = runShellCommand,
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
  const freshPlan = assertFreshApplyPlan({ cwd, plan, sourceSha, now, planMaxAgeMinutes });
  const plannedApplyEvidence = collectAdapterEvidence({
    cwd,
    config,
    stages: ["apply"],
    executeAdapterCommands: false,
    runner: commandRunner,
  });
  if (dryRun) {
    return {
      schemaVersion: 1,
      contract: APPLY_CONTRACT,
      status: "planned",
      dryRun: true,
      approvalId,
      sourceSha: freshPlan.sourceSha,
      planHash: freshPlan.plan.planHash,
      inputHash: freshPlan.inputHash,
      planAgeSeconds: freshPlan.ageSeconds,
      planMaxAgeMinutes: freshPlan.planMaxAgeMinutes,
      mutationAllowed: false,
      mutationExecuted: false,
      adapterEvidence: plannedApplyEvidence,
    };
  }
  if (!executeAdapterCommands) {
    throw new Error("infra-contract apply requires --execute-adapter-commands true before mutation");
  }
  const applyTemplate = adapterCommandTemplate({ config, stage: "apply" });
  if (!applyTemplate?.executable) {
    throw new Error(`infra-contract apply execution requires infra.commands.apply for adapter: ${config.infra.adapter}`);
  }
  const adapterEvidence = collectAdapterEvidence({
    cwd,
    config,
    stages: ["apply"],
    executeAdapterCommands: true,
    runner: commandRunner,
  });
  assertAdapterEvidencePassed(adapterEvidence);
  return {
    schemaVersion: 1,
    contract: APPLY_CONTRACT,
    status: "completed",
    dryRun: false,
    approvalId,
    sourceSha: freshPlan.sourceSha,
    planHash: freshPlan.plan.planHash,
    inputHash: freshPlan.inputHash,
    planAgeSeconds: freshPlan.ageSeconds,
    planMaxAgeMinutes: freshPlan.planMaxAgeMinutes,
    mutationAllowed: true,
    mutationExecuted: true,
    adapterEvidence,
  };
}
