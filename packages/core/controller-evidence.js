import crypto from "node:crypto";

export const BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT = "buildchain.controller-evidence/v1";
export const BUILDCHAIN_CONTROLLER_DESCRIPTOR_CONTRACT = "buildchain.controller-descriptor/v1";
export const BUILDCHAIN_CONTROLLER_REGISTRY_CONTRACT = "buildchain.controller-registry/v1";
export const BUILDCHAIN_CONTROLLER_AGGREGATE_CONTRACT = "buildchain.controller-evidence-aggregate/v1";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const STAGE_STATUSES = new Set(["passed", "failed", "skipped", "cancelled", "missing"]);

const CONTROLLER_SPECS = [
  {
    id: "source-check",
    workflowId: "check",
    version: 1,
    capabilities: ["source-acceptance", "lifecycle-check"],
    stages: ["resolve-runtime", "checkout-source", "install", "check", "aggregate"],
    evidence: ["lifecycle-manifest", "lifecycle-summary", "controller-receipt"],
  },
  {
    id: "build-lifecycle",
    workflowId: ".build",
    version: 1,
    capabilities: ["source-lock", "lifecycle-build", "lifecycle-verify", "artifact-admission"],
    stages: ["resolve-runtime", "resolve-source", "build", "verify", "aggregate"],
    evidence: ["platform-manifests", "build-summary", "controller-receipt"],
  },
  {
    id: "build-channel-router",
    workflowId: "build",
    version: 1,
    capabilities: ["channel-selection", "runtime-selection", "build-delegation"],
    stages: ["resolve-channel", "build", "aggregate"],
    evidence: ["nested-controller-receipt", "controller-receipt"],
  },
  {
    id: "shifu-gate-profile-envelope",
    workflowId: ".gate-profile",
    version: 1,
    capabilities: ["shifu-gate-profile-delegation"],
    stages: ["plan", "execute", "aggregate"],
    evidence: ["shifu-gate-aggregate", "controller-receipt"],
    semanticBoundary: "References the Shifu aggregate digest and status without copying project Gate identifiers or Gate policy.",
  },
  {
    id: "web-surface",
    workflowId: ".web-surface",
    version: 1,
    capabilities: ["web-build", "web-verify", "deployment-plan", "deployment-apply", "publication-authority"],
    stages: ["resolve-runtime", "plan", "build", "verify", "publication-authority", "apply", "aggregate"],
    optionalStages: ["build", "verify", "publication-authority", "apply"],
    evidence: ["web-surface-plan", "controller-receipt"],
  },
  {
    id: "publication-artifact",
    workflowId: "publication-artifact",
    version: 1,
    capabilities: ["publication-build", "publication-verify", "artifact-admission"],
    stages: ["resolve-runtime", "build", "verify", "collect", "aggregate"],
    optionalStages: ["verify"],
    evidence: ["publication-manifest", "publication-passport", "controller-receipt"],
  },
  {
    id: "paper-release",
    workflowId: "paper-release",
    version: 1,
    capabilities: ["publication-build", "artifact-admission", "publication-authority", "release-publish", "release-passport"],
    stages: ["resolve-runtime", "build", "verify", "collect", "publication-authority", "publish", "passport", "aggregate"],
    optionalStages: ["verify"],
    evidence: ["publication-manifest", "release-passport", "controller-receipt"],
  },
  {
    id: "release-candidate-promotion",
    workflowId: "release-candidate-promote",
    version: 1,
    capabilities: ["promotion-preflight", "artifact-admission", "publication-authority", "publish-transaction", "release-passport"],
    stages: ["preflight", "admit-release-candidate", "publication-authority", "publish", "passport", "aggregate"],
    evidence: ["release-candidate-passport", "publish-evidence", "release-passport", "controller-receipt"],
  },
  {
    id: "release-propagation",
    workflowId: "release-propagation",
    version: 1,
    capabilities: ["release-propagation-plan", "downstream-lock", "pull-request-handoff"],
    stages: ["resolve-runtime", "plan", "write-lock", "open-pr", "aggregate"],
    optionalStages: ["open-pr"],
    evidence: ["propagation-plan", "propagation-lock", "controller-receipt"],
  },
];

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function controllerEvidenceDigest(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function digestDocument(value) {
  const { digest: _digest, ...content } = value;
  return controllerEvidenceDigest(content);
}

function nonEmptyString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function exactSha(value, label) {
  const normalized = nonEmptyString(value, label).toLowerCase();
  if (!GIT_SHA_PATTERN.test(normalized)) throw new Error(`${label} must be a 40-character Git SHA`);
  return normalized;
}

function sha256Digest(value, label) {
  const normalized = nonEmptyString(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} must be a sha256 digest`);
  return normalized;
}

function unique(values = []) {
  return [...new Set(values.map(String).filter(Boolean))];
}

function classifyInput(name, secretNames = new Set()) {
  if (secretNames.has(name) || /(?:^|[-_])(token|secret|private[-_]?key)(?:$|[-_])/i.test(name)) {
    return "redacted";
  }
  if (/(?:command|json|body|notes|role-arn|runner|mirror-url|repository-template|path|directory|environment|registry-index|s3-(?:bucket|region|prefix)|container-image|checkout-cache|hostname|endpoint|address)/i.test(name)) {
    return "digest-only";
  }
  return "included";
}

function descriptorDigest(descriptor) {
  const { digest: _digest, ...content } = descriptor;
  return controllerEvidenceDigest(content);
}

export function createControllerRegistry({ workflows = [] } = {}) {
  const workflowById = new Map(workflows.map((entry) => [entry.id, entry]));
  const controllers = CONTROLLER_SPECS.map((spec) => {
    const workflow = workflowById.get(spec.workflowId);
    if (!workflow) throw new Error(`controller ${spec.id} requires workflow descriptor ${spec.workflowId}`);
    const secrets = new Set(unique(workflow.secrets));
    const names = unique([...(workflow.inputs || []), ...secrets]).sort();
    const inputs = Object.fromEntries(names.map((name) => [name, {
      classification: classifyInput(name, secrets),
      source: secrets.has(name) ? "workflow-call-secret" : "workflow-call-input",
    }]));
    for (const [name, policy] of Object.entries(workflow.inputPolicies || {})) {
      if (!inputs[name]) throw new Error(`controller ${spec.id} input policy references undeclared input ${name}`);
      inputs[name] = { ...inputs[name], ...policy };
    }
    const optionalStages = new Set(spec.optionalStages || []);
    const descriptor = {
      schemaVersion: 1,
      contract: BUILDCHAIN_CONTROLLER_DESCRIPTOR_CONTRACT,
      id: spec.id,
      version: spec.version,
      workflow: { id: workflow.id, path: workflow.path },
      inputs,
      expected: {
        stages: spec.stages.map((id) => ({ id, required: !optionalStages.has(id) })),
        capabilities: [...spec.capabilities],
        evidence: [...spec.evidence],
      },
      ...(spec.semanticBoundary ? { semanticBoundary: spec.semanticBoundary } : {}),
    };
    descriptor.digest = descriptorDigest(descriptor);
    return descriptor;
  });
  const registry = {
    schemaVersion: 1,
    contract: BUILDCHAIN_CONTROLLER_REGISTRY_CONTRACT,
    controllers,
  };
  registry.digest = digestDocument(registry);
  return registry;
}

function normalizeIncludedValue(value, label, name) {
  if (value === undefined) return undefined;
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "string") {
    if (/(?:path|directory)/i.test(name) && (/^(?:\/|~[\\/]|[A-Za-z]:[\\/])/.test(value))) {
      throw new Error(`${label} must not expose an absolute runner path`);
    }
    return value;
  }
  throw new Error(`${label} must use digest-only classification for structured values`);
}

function normalizeInputs(descriptor, supplied = {}) {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new Error("controller inputs must be an object");
  }
  for (const name of Object.keys(supplied)) {
    if (!descriptor.inputs?.[name]) throw new Error(`undeclared controller input: ${name}`);
  }
  const normalized = {};
  const issues = [];
  for (const name of Object.keys(descriptor.inputs || {}).sort()) {
    const policy = descriptor.inputs[name];
    const provided = Object.hasOwn(supplied, name) && supplied[name] !== undefined;
    if (policy.classification === "included") {
      normalized[name] = {
        classification: "included",
        provided,
        ...(provided ? { value: normalizeIncludedValue(supplied[name], `controller input ${name}`, name) } : {}),
      };
    } else if (policy.classification === "digest-only") {
      normalized[name] = {
        classification: "digest-only",
        provided,
        ...(provided ? { digest: controllerEvidenceDigest(supplied[name]) } : {}),
      };
    } else if (policy.classification === "redacted") {
      normalized[name] = { classification: "redacted" };
    } else if (policy.classification === "unsupported") {
      normalized[name] = { classification: "unsupported", provided };
      if (provided) issues.push(`unsupported controller input was provided: ${name}`);
    } else {
      throw new Error(`unsupported controller input classification for ${name}: ${policy.classification}`);
    }
  }
  return { normalized, issues };
}

export function createControllerPlan({ descriptor, source = {}, runtime = {}, inputs = {} } = {}) {
  if (!descriptor || descriptor.contract !== BUILDCHAIN_CONTROLLER_DESCRIPTOR_CONTRACT) {
    throw new Error("descriptor must use buildchain.controller-descriptor/v1");
  }
  if (descriptor.digest !== descriptorDigest(descriptor)) throw new Error("controller descriptor digest mismatch");
  const normalizedInputs = normalizeInputs(descriptor, inputs);
  const plan = {
    schemaVersion: 1,
    contract: BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT,
    kind: "plan",
    controller: {
      id: descriptor.id,
      version: descriptor.version,
      descriptorDigest: descriptor.digest,
      workflow: { ...descriptor.workflow },
    },
    source: {
      repository: nonEmptyString(source.repository, "source.repository"),
      sha: exactSha(source.sha, "source.sha"),
    },
    runtime: {
      ref: nonEmptyString(runtime.ref, "runtime.ref"),
      sha: exactSha(runtime.sha, "runtime.sha"),
      contractDigest: sha256Digest(runtime.contractDigest, "runtime.contractDigest"),
    },
    inputs: normalizedInputs.normalized,
    expected: {
      stages: descriptor.expected.stages.map((stage) => ({ ...stage })),
      capabilities: [...descriptor.expected.capabilities],
      evidence: [...descriptor.expected.evidence],
    },
    qualifying: normalizedInputs.issues.length === 0,
    issues: normalizedInputs.issues,
  };
  plan.digest = digestDocument(plan);
  return plan;
}

export function validateControllerPlan(plan) {
  const issues = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { ok: false, qualifying: false, issues: ["plan must be an object"] };
  if (plan.contract !== BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT) issues.push(`plan contract must be ${BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT}`);
  if (plan.kind !== "plan") issues.push("plan kind must be plan");
  if (!GIT_SHA_PATTERN.test(String(plan.source?.sha || ""))) issues.push("plan source SHA must be exact");
  if (!GIT_SHA_PATTERN.test(String(plan.runtime?.sha || ""))) issues.push("plan runtime SHA must be exact");
  if (!SHA256_PATTERN.test(String(plan.runtime?.contractDigest || ""))) issues.push("plan runtime contract digest is invalid");
  if (plan.digest !== digestDocument(plan)) issues.push("plan digest mismatch");
  for (const [name, input] of Object.entries(plan.inputs || {})) {
    if (input.classification === "redacted" && ("value" in input || "digest" in input || "provided" in input)) {
      issues.push(`redacted input leaked metadata: ${name}`);
    }
    if (input.classification === "digest-only" && input.provided && !SHA256_PATTERN.test(String(input.digest || ""))) {
      issues.push(`digest-only input is missing a digest: ${name}`);
    }
  }
  const qualifying = issues.length === 0 && plan.qualifying === true;
  return { ok: issues.length === 0, qualifying, issues: [...issues, ...(plan.issues || [])] };
}

function normalizeEvidence(entries = []) {
  return entries.map((entry, index) => ({
    kind: nonEmptyString(entry.kind, `evidence[${index}].kind`),
    digest: sha256Digest(entry.digest, `evidence[${index}].digest`),
    ...(entry.artifact ? { artifact: String(entry.artifact) } : {}),
  }));
}

function receiptStatus(plan, stages) {
  if (stages.some((stage) => stage.status === "failed")) return "failed";
  if (stages.length > 0 && stages.every((stage) => stage.status === "skipped")) return "skipped";
  if (stages.some((stage) => stage.status === "cancelled" || (stage.required && stage.status === "missing"))) return "partial";
  const required = new Set(plan.expected.stages.filter((stage) => stage.required).map((stage) => stage.id));
  if (stages.filter((stage) => required.has(stage.id)).every((stage) => stage.status === "passed")) return "passed";
  return "partial";
}

export function createControllerReceipt({ plan, stages = [], evidence = [], reason = undefined, artifact = "" } = {}) {
  const planValidation = validateControllerPlan(plan);
  if (!planValidation.ok) throw new Error(`controller plan is invalid: ${planValidation.issues.join("; ")}`);
  const expected = new Map(plan.expected.stages.map((stage) => [stage.id, stage]));
  const supplied = new Map();
  for (const [index, stage] of stages.entries()) {
    const id = nonEmptyString(stage.id, `stages[${index}].id`);
    if (!expected.has(id)) throw new Error(`undeclared controller stage: ${id}`);
    if (supplied.has(id)) throw new Error(`duplicate controller stage: ${id}`);
    const status = nonEmptyString(stage.status, `stages[${index}].status`);
    if (!STAGE_STATUSES.has(status)) throw new Error(`unsupported controller stage status: ${status}`);
    supplied.set(id, {
      id,
      required: expected.get(id).required,
      status,
      evidence: normalizeEvidence(stage.evidence || []),
    });
  }
  const normalizedStages = plan.expected.stages.map((stage) => supplied.get(stage.id) || {
    id: stage.id,
    required: stage.required,
    status: "missing",
    evidence: [],
  });
  const status = receiptStatus(plan, normalizedStages);
  const normalizedEvidence = normalizeEvidence(evidence);
  const availableEvidence = new Set([
    ...normalizedEvidence.map((entry) => entry.kind),
    ...normalizedStages.flatMap((stage) => stage.evidence.map((entry) => entry.kind)),
  ]);
  const missingEvidence = plan.expected.evidence
    .filter((kind) => kind !== "controller-receipt" && !availableEvidence.has(kind));
  const issues = status === "passed"
    ? missingEvidence.map((kind) => `required controller evidence is missing: ${kind}`)
    : [];
  const receipt = {
    schemaVersion: 1,
    contract: BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT,
    kind: "receipt",
    controller: { ...plan.controller },
    source: { ...plan.source },
    runtime: { ...plan.runtime },
    planDigest: plan.digest,
    status,
    qualifying: status === "passed" && plan.qualifying === true && issues.length === 0,
    stages: normalizedStages,
    evidence: normalizedEvidence,
    issues,
    ...(reason ? {
      reason: {
        code: nonEmptyString(reason.code, "reason.code"),
        summary: nonEmptyString(reason.summary, "reason.summary"),
      },
    } : {}),
    ...(artifact ? { artifact: String(artifact) } : {}),
  };
  receipt.digest = digestDocument(receipt);
  return receipt;
}

export function validateControllerReceipt(receipt, {
  plan = undefined,
  expectedSourceSha = "",
  expectedRuntimeSha = "",
  expectedPlanDigest = "",
} = {}) {
  const issues = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return { ok: false, qualifying: false, issues: ["receipt must be an object"] };
  if (receipt.contract !== BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT) issues.push(`receipt contract must be ${BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT}`);
  if (receipt.kind !== "receipt") issues.push("receipt kind must be receipt");
  if (receipt.digest !== digestDocument(receipt)) issues.push("receipt digest mismatch");
  issues.push(...(receipt.issues || []));
  if (plan) {
    if (receipt.planDigest !== plan.digest) issues.push("receipt plan digest mismatch");
    if (receipt.controller?.id !== plan.controller?.id) issues.push("receipt controller mismatch");
    if (receipt.source?.sha !== plan.source?.sha) issues.push("receipt source SHA mismatch");
    if (receipt.runtime?.sha !== plan.runtime?.sha) issues.push("receipt runtime SHA mismatch");
  }
  if (expectedSourceSha && receipt.source?.sha !== expectedSourceSha) issues.push("receipt source SHA mismatch");
  if (expectedRuntimeSha && receipt.runtime?.sha !== expectedRuntimeSha) issues.push("receipt runtime SHA mismatch");
  if (expectedPlanDigest && receipt.planDigest !== expectedPlanDigest) issues.push("receipt plan digest mismatch");
  const qualifying = issues.length === 0 && receipt.qualifying === true && receipt.status === "passed";
  return { ok: issues.length === 0, qualifying, issues };
}

export function aggregateControllerReceipts({ plans = [], receipts = [] } = {}) {
  const byPlan = new Map(receipts.map((receipt) => [receipt.planDigest, receipt]));
  const rows = [];
  const issues = [];
  for (const plan of plans) {
    const receipt = byPlan.get(plan.digest);
    if (!receipt) {
      rows.push({ controllerId: plan.controller.id, planDigest: plan.digest, status: "receipt-missing", qualifying: false });
      issues.push(`${plan.controller.id}: receipt is missing`);
      continue;
    }
    const validation = validateControllerReceipt(receipt, { plan });
    rows.push({
      controllerId: plan.controller.id,
      planDigest: plan.digest,
      receiptDigest: receipt.digest,
      status: validation.ok ? receipt.status : "invalid",
      qualifying: validation.qualifying,
    });
    issues.push(...validation.issues.map((issue) => `${plan.controller.id}: ${issue}`));
  }
  const status = rows.some((row) => row.status === "receipt-missing")
    ? "receipt-missing"
    : rows.some((row) => row.status === "failed" || row.status === "invalid")
      ? "failed"
      : rows.some((row) => row.status === "partial")
        ? "partial"
        : rows.length > 0 && rows.every((row) => row.status === "skipped")
          ? "skipped"
          : "passed";
  const aggregate = {
    schemaVersion: 1,
    contract: BUILDCHAIN_CONTROLLER_AGGREGATE_CONTRACT,
    status,
    qualifying: status === "passed" && rows.every((row) => row.qualifying),
    controllers: rows,
    issues,
  };
  aggregate.digest = digestDocument(aggregate);
  return aggregate;
}

export function createControllerReceiptReference(receipt) {
  const validation = validateControllerReceipt(receipt);
  if (!validation.ok) throw new Error(`controller receipt is invalid: ${validation.issues.join("; ")}`);
  return {
    controllerId: receipt.controller.id,
    planDigest: receipt.planDigest,
    receiptDigest: receipt.digest,
    sourceSha: receipt.source.sha,
    runtimeSha: receipt.runtime.sha,
    status: receipt.status,
    artifact: receipt.artifact || "",
  };
}

export function validateControllerReceiptReference(reference, {
  expectedSourceSha = "",
  acceptedSourceShas = [],
  expectedRuntimeSha = "",
  requirePassed = false,
} = {}) {
  const issues = [];
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    return { ok: false, issues: ["controller receipt reference must be an object"] };
  }
  if (!String(reference.controllerId || "").trim()) issues.push("controller receipt reference controllerId is required");
  if (!SHA256_PATTERN.test(String(reference.planDigest || ""))) issues.push("controller receipt reference plan digest is invalid");
  if (!SHA256_PATTERN.test(String(reference.receiptDigest || ""))) issues.push("controller receipt reference receipt digest is invalid");
  if (!GIT_SHA_PATTERN.test(String(reference.sourceSha || ""))) issues.push("controller receipt reference source SHA is invalid");
  if (!GIT_SHA_PATTERN.test(String(reference.runtimeSha || ""))) issues.push("controller receipt reference runtime SHA is invalid");
  if (!["passed", "failed", "skipped", "partial"].includes(String(reference.status || ""))) {
    issues.push("controller receipt reference status is invalid");
  }
  if (requirePassed && reference.status !== "passed") issues.push("controller receipt reference status must be passed");
  const allowedSourceShas = new Set([expectedSourceSha, ...(acceptedSourceShas || [])].filter(Boolean));
  if (allowedSourceShas.size > 0 && !allowedSourceShas.has(reference.sourceSha)) {
    issues.push("controller receipt reference source SHA mismatch");
  }
  if (expectedRuntimeSha && reference.runtimeSha !== expectedRuntimeSha) issues.push("controller receipt reference runtime SHA mismatch");
  return { ok: issues.length === 0, issues };
}

export function normalizeControllerReceiptReferences({
  receipts = [],
  references = [],
  expectedSourceSha = "",
  acceptedSourceShas = [],
  expectedRuntimeSha = "",
  requirePassed = false,
} = {}) {
  const normalized = [
    ...(receipts || []).map(createControllerReceiptReference),
    ...(references || []).map((reference) => ({ ...reference, artifact: String(reference.artifact || "") })),
  ];
  const seen = new Set();
  for (const reference of normalized) {
    const validation = validateControllerReceiptReference(reference, {
      expectedSourceSha,
      acceptedSourceShas,
      expectedRuntimeSha,
      requirePassed,
    });
    if (!validation.ok) throw new Error(`controller receipt reference is invalid: ${validation.issues.join("; ")}`);
    if (seen.has(reference.controllerId)) throw new Error(`duplicate controller receipt reference: ${reference.controllerId}`);
    seen.add(reference.controllerId);
  }
  return normalized.sort((left, right) => left.controllerId.localeCompare(right.controllerId));
}
