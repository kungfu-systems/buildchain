import crypto from "node:crypto";

export const GATE_MATRIX_CONTRACT = "buildchain.shifu-gate-matrix/v1";
export const GATE_AGGREGATE_CONTRACT = "buildchain.shifu-gate-aggregate/v1";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function shifuGateRunPlanDigest(plan) {
  return sha256({
    registryDigest: plan.registry.digest,
    profile: plan.profile,
    platform: plan.platform,
    includeAdvisory: plan.includeAdvisory,
    explicitGates: plan.explicitGates,
    qualifying: plan.qualifying,
    groups: plan.groups.map((group) => ({
      index: group.index,
      gates: group.gates.map((gate) => ({
        id: gate.id,
        mode: gate.mode,
        selectedBy: gate.selectedBy,
        dependencies: gate.dependencies,
        actionId: gate.actionId,
        definitionDigest: gate.definitionDigest,
      })),
    })),
    skipped: plan.skipped,
    unsupported: plan.unsupported,
  });
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function uniqueStrings(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const normalized = value.map((item) => String(item || "").trim());
  if (normalized.some((item) => !item)) {
    throw new Error(`${label} must contain non-empty strings`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return normalized;
}

function inferShifuPlatform(platform) {
  const explicit = String(platform.platform || "")
    .trim()
    .toLowerCase();
  if (explicit) return explicit;
  const probe =
    `${platform.id || ""} ${platform.name || ""} ${platform.runner || ""}`.toLowerCase();
  if (probe.includes("windows")) return "windows";
  if (probe.includes("macos") || probe.includes("mac os")) return "macos";
  if (probe.includes("linux") || probe.includes("ubuntu")) return "linux";
  throw new Error(
    `platform ${platform.id || "(unknown)"} requires a platform field`,
  );
}

export function normalizeGatePlatform(platform, index = 0) {
  assertObject(platform, `platforms[${index}]`);
  const id = String(platform.id || "").trim();
  const name = String(platform.name || id).trim();
  const runner = String(platform.runner || "").trim();
  if (!id) throw new Error(`platforms[${index}].id is required`);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(
      `platforms[${index}].id may only contain letters, numbers, dot, underscore, and hyphen`,
    );
  }
  if (!name) throw new Error(`platforms[${index}].name is required`);
  if (!runner) throw new Error(`platforms[${index}].runner is required`);
  let labels;
  try {
    labels = JSON.parse(runner);
  } catch (error) {
    throw new Error(
      `platforms[${index}].runner must be valid JSON: ${error.message}`,
    );
  }
  if (
    !Array.isArray(labels) ||
    labels.length === 0 ||
    labels.some((label) => typeof label !== "string" || !label)
  ) {
    throw new Error(
      `platforms[${index}].runner must be a non-empty JSON string array`,
    );
  }
  return {
    id,
    name,
    platform: inferShifuPlatform(platform),
    runner,
    capabilities: uniqueStrings(
      platform.capabilities || ["node"],
      `platforms[${index}].capabilities`,
    ).sort(),
    required: platform.required !== false,
  };
}

export function inspectGatePlan(plan, { profile, platform } = {}) {
  assertObject(plan, "Shifu gate plan");
  if (plan.schema !== "shifu.gate-plan/v1") {
    throw new Error(
      `unsupported Shifu gate plan schema: ${plan.schema || "(missing)"}`,
    );
  }
  if (profile && plan.profile !== profile) {
    throw new Error(
      `Shifu gate plan profile mismatch: expected ${profile}, got ${plan.profile || "(missing)"}`,
    );
  }
  if (platform && plan.platform !== platform) {
    throw new Error(
      `Shifu gate plan platform mismatch: expected ${platform}, got ${plan.platform || "(missing)"}`,
    );
  }
  const registry = assertObject(plan.registry, "Shifu gate plan registry");
  if (
    !registry.projectId ||
    !/^sha256:[0-9a-f]{64}$/.test(registry.digest || "")
  ) {
    throw new Error(
      "Shifu gate plan registry requires projectId and sha256 digest",
    );
  }
  if (!Array.isArray(plan.groups))
    throw new Error("Shifu gate plan groups must be an array");
  const gates = plan.groups.flatMap((group, groupIndex) => {
    if (group.index !== groupIndex || !Array.isArray(group.gates)) {
      throw new Error(
        "Shifu gate plan groups must use contiguous indexes and gate arrays",
      );
    }
    return group.gates.map((gate) => ({ ...gate, group: group.index }));
  });
  const ids = gates.map((gate) => String(gate.id || ""));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("Shifu gate plan gate ids must be non-empty and unique");
  }
  for (const gate of gates) {
    if (!["required", "advisory"].includes(gate.mode)) {
      throw new Error(
        `planned gate ${gate.id} has unsupported mode ${gate.mode}`,
      );
    }
    if (
      !/^sha256:[0-9a-f]{64}$/.test(gate.actionId || "") ||
      !/^sha256:[0-9a-f]{64}$/.test(gate.definitionDigest || "")
    ) {
      throw new Error(
        `planned gate ${gate.id} requires actionId and definitionDigest sha256 digests`,
      );
    }
  }
  const requiredCapabilities = [
    ...new Set(gates.flatMap((gate) => gate.runner?.capabilities || [])),
  ].sort();
  return {
    plan,
    gates,
    requiredCapabilities,
    planDigest: shifuGateRunPlanDigest(plan),
  };
}

export function createGateExecutionMatrix({
  profile,
  includeAdvisory = false,
  platforms,
  plans,
}) {
  if (!profile) throw new Error("gate profile is required");
  const normalizedPlatforms = platforms.map(normalizeGatePlatform);
  const planMap =
    plans instanceof Map ? plans : new Map(Object.entries(plans || {}));
  const entries = [];
  const omitted = [];
  let registryIdentity;

  for (const platform of normalizedPlatforms) {
    const inspected = inspectGatePlan(planMap.get(platform.id), {
      profile,
      platform: platform.platform,
    });
    const identity = `${inspected.plan.registry.projectId}\u0000${inspected.plan.registry.digest}`;
    if (registryIdentity && registryIdentity !== identity) {
      throw new Error(
        "all Shifu gate plans must use the same project and registry digest",
      );
    }
    registryIdentity = identity;
    const missingCapabilities = inspected.requiredCapabilities.filter(
      (capability) =>
        capability !== "node" && !platform.capabilities.includes(capability),
    );
    const unsupportedRequired = (inspected.plan.unsupported || []).filter(
      (item) => item.mode === "required",
    );
    const reasons = [];
    if (inspected.plan.ok !== true || inspected.plan.qualifying !== true)
      reasons.push("plan is not qualifying");
    if (unsupportedRequired.length)
      reasons.push(
        `required gates unsupported: ${unsupportedRequired.map((item) => item.id).join(", ")}`,
      );
    if (missingCapabilities.length)
      reasons.push(
        `runner capabilities missing: ${missingCapabilities.join(", ")}`,
      );
    if (reasons.length) {
      omitted.push({
        id: platform.id,
        platform: platform.platform,
        required: platform.required,
        reasons,
      });
      if (platform.required)
        throw new Error(
          `required gate platform ${platform.id} cannot run: ${reasons.join("; ")}`,
        );
      continue;
    }
    const timeoutSeconds = inspected.gates.reduce(
      (total, gate) =>
        total + Math.max(0, Number(gate.cost?.timeoutSeconds || 0)),
      0,
    );
    entries.push({
      id: platform.id,
      name: platform.name,
      platform: platform.platform,
      runner: platform.runner,
      capabilities: platform.capabilities,
      required: platform.required,
      profile,
      includeAdvisory: Boolean(includeAdvisory),
      registry: inspected.plan.registry,
      planDigest: inspected.planDigest,
      timeoutMinutes: Math.max(
        1,
        Math.min(360, Math.ceil(timeoutSeconds / 60)),
      ),
      gates: inspected.gates.map((gate) => ({
        id: gate.id,
        mode: gate.mode,
        group: gate.group,
        actionId: gate.actionId,
        definitionDigest: gate.definitionDigest,
      })),
      skipped: inspected.plan.skipped || [],
      unsupported: inspected.plan.unsupported || [],
    });
  }
  if (entries.length === 0)
    throw new Error("gate profile matrix has no runnable platforms");
  const base = {
    contract: GATE_MATRIX_CONTRACT,
    profile,
    includeAdvisory: Boolean(includeAdvisory),
    registry: entries[0].registry,
    entries,
    omitted,
  };
  return { ...base, digest: sha256(base) };
}

function resultKey(platformId, gateId) {
  return `${platformId}\u0000${gateId}`;
}

function validateExecution(entry, execution, sourceSha) {
  const issues = [];
  const receipt = execution?.receipt;
  const validation = execution?.validation;
  if (!receipt) return { issues: ["receipt is missing"], gateRows: [] };
  if (!validation) issues.push("Shifu receipt validation is missing");
  else {
    if (validation.schema !== "shifu.gate-receipt-validation/v1")
      issues.push("receipt validation schema is unsupported");
    if (validation.valid !== true) issues.push("receipt is invalid");
    if (validation.current !== true) issues.push("receipt is stale");
    if (validation.qualifying !== true)
      issues.push("receipt is non-qualifying");
  }
  if (receipt.schema !== "shifu.gate-receipt/v1")
    issues.push("receipt schema is unsupported");
  if (receipt.source?.sha !== sourceSha)
    issues.push("receipt source SHA does not match the locked source");
  if (receipt.source?.dirty !== false) issues.push("receipt source is dirty");
  if (receipt.selection?.profile !== entry.profile)
    issues.push("receipt profile does not match the matrix");
  if (receipt.environment?.platform !== entry.platform)
    issues.push("receipt platform does not match the matrix");
  if (
    receipt.registry?.digest !== entry.registry.digest ||
    receipt.registry?.projectId !== entry.registry.projectId
  ) {
    issues.push("receipt registry identity does not match the matrix");
  }
  if (receipt.plan?.digest !== entry.planDigest)
    issues.push("receipt plan digest does not match the matrix");
  if (receipt.ok !== true || receipt.qualifying !== true)
    issues.push("receipt did not qualify");
  const results = new Map(
    (receipt.results || []).map((result) => [result.gateId, result]),
  );
  const gateRows = entry.gates.map((expected) => {
    const actual = results.get(expected.id);
    const gateIssues = [];
    if (!actual) gateIssues.push("result is missing");
    else {
      if (actual.policyMode !== expected.mode)
        gateIssues.push("policy mode mismatch");
      if (actual.actionId !== expected.actionId)
        gateIssues.push("action digest mismatch");
      if (actual.definitionDigest !== expected.definitionDigest)
        gateIssues.push("definition digest mismatch");
      if (expected.mode === "required" && actual.status !== "pass")
        gateIssues.push(`required status is ${actual.status}`);
      if (expected.mode === "required" && actual.attempted !== true)
        gateIssues.push("required action was not attempted");
    }
    if (gateIssues.length)
      issues.push(`${expected.id}: ${gateIssues.join(", ")}`);
    return {
      key: resultKey(entry.id, expected.id),
      platformId: entry.id,
      gateId: expected.id,
      mode: expected.mode,
      status: actual?.status || "missing",
      attempted: actual?.attempted === true,
      definitionDigest: expected.definitionDigest,
      actionId: expected.actionId,
      evidence: actual?.evidence || null,
      artifacts: actual?.artifacts || [],
      issues: gateIssues,
    };
  });
  return { issues, gateRows };
}

export function createGateAggregate({ matrix, sourceSha, executions }) {
  if (matrix?.contract !== GATE_MATRIX_CONTRACT)
    throw new Error("unsupported gate matrix contract");
  if (!/^[0-9a-f]{40}$/i.test(sourceSha || ""))
    throw new Error("gate aggregate requires a 40-character source SHA");
  const executionMap =
    executions instanceof Map
      ? executions
      : new Map(Object.entries(executions || {}));
  const receipts = [];
  const gates = [];
  const issues = [];
  for (const entry of matrix.entries) {
    const execution = executionMap.get(entry.id);
    const validated = validateExecution(entry, execution, sourceSha);
    issues.push(...validated.issues.map((issue) => `${entry.id}: ${issue}`));
    gates.push(...validated.gateRows);
    receipts.push({
      platformId: entry.id,
      platform: entry.platform,
      runId: execution?.receipt?.runId || "",
      status: execution?.receipt?.status || "missing",
      qualifying:
        execution?.receipt?.qualifying === true &&
        execution?.validation?.qualifying === true,
      integrityDigest: execution?.receipt?.integrity?.digest || "",
      issues: validated.issues,
    });
  }
  const base = {
    contract: GATE_AGGREGATE_CONTRACT,
    profile: matrix.profile,
    sourceSha,
    registry: matrix.registry,
    matrixDigest: matrix.digest,
    status: issues.length ? "fail" : "pass",
    ok: issues.length === 0,
    qualifying: issues.length === 0,
    receipts,
    gates,
    omitted: matrix.omitted,
    issues,
  };
  return { ...base, digest: sha256(base) };
}
