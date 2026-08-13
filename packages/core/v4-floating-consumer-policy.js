import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseYamlUses } from "./workflow-yaml-contract.js";

export const V4_FLOATING_CONSUMER_POLICY =
  "kungfu-buildchain-v4-floating-consumer-policy/v1";
export const V4_FLOATING_CONSUMER_RECEIPT =
  "kungfu-buildchain-v4-floating-consumer-policy-receipt/v1";
export const V4_FLOATING_CONSUMER_CERTIFICATION =
  "kungfu-buildchain-v4-floating-consumer-certification/v1";

const EXACT_SHA = /^[0-9a-f]{40}$/u;
const SHA256_ROOT = /^sha256:[0-9a-f]{64}$/u;
const BUILDCHAIN_REPOSITORY = "kungfu-systems/buildchain";
const CHANNELS = Object.freeze({ v4: "stable", "v4-alpha": "alpha" });

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function readJson(root, relative, label) {
  const file = path.resolve(root, relative);
  if (
    !file.startsWith(`${path.resolve(root)}${path.sep}`) ||
    !fs.existsSync(file)
  ) {
    throw new Error(`${label} is missing: ${relative}`);
  }
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")), file };
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function listWorkflowFiles(root) {
  const directory = path.join(root, ".github", "workflows");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort();
}

function coordinate(value) {
  const match = String(value || "").match(/^([^/]+\/[^/]+)\/(.+)@([^@]+)$/u);
  return match
    ? { repository: match[1], path: match[2], selector: match[3] }
    : null;
}

function localActionManifest(root, sourcePath, uses) {
  if (!uses.startsWith("./")) return "";
  const target = path.resolve(root, uses);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) return "";
  const candidates =
    fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? [path.join(target, "action.yml"), path.join(target, "action.yaml")]
      : [target];
  const manifest = candidates.find((candidate) => fs.existsSync(candidate));
  if (!manifest) {
    throw new Error(`${sourcePath} references missing local action ${uses}`);
  }
  return path.relative(root, manifest).split(path.sep).join("/");
}

function enumerateUses(root) {
  const queue = listWorkflowFiles(root);
  const visited = new Set();
  const records = [];
  while (queue.length) {
    const relative = queue.shift();
    if (visited.has(relative)) continue;
    visited.add(relative);
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    for (const node of parseYamlUses(text)) {
      records.push({
        sourcePath: relative,
        line: node.line,
        scalarKind: node.scalar.kind,
        uses: node.value,
      });
      const manifest = localActionManifest(root, relative, node.value);
      if (manifest && !visited.has(manifest)) queue.push(manifest);
    }
  }
  return {
    files: [...visited].sort().map((relative) => ({
      path: relative,
      digest: sha256(fs.readFileSync(path.join(root, relative))),
    })),
    records,
  };
}

function validateLock(lock, expectedRef, label, failures) {
  if (lock?.contract !== "kungfu-buildchain-contract-lock") {
    failures.push({
      code: `${label}-contract-invalid`,
      message: `${label} must be a Buildchain contract lock`,
    });
    return;
  }
  if (lock.buildchain?.ref !== expectedRef) {
    failures.push({
      code: `${label}-channel-mismatch`,
      message: `${label} must bind ${expectedRef}`,
    });
  }
  if (lock.buildchain?.majorLine !== "v4") {
    failures.push({
      code: `${label}-major-mismatch`,
      message: `${label} must bind major line v4`,
    });
  }
  if (
    !EXACT_SHA.test(String(lock.buildchain?.resolvedSha || "").toLowerCase())
  ) {
    failures.push({
      code: `${label}-sha-invalid`,
      message: `${label} resolvedSha must be an exact commit SHA`,
    });
  }
  for (const field of ["contractDigest", "compatibilityDigest"]) {
    if (!SHA256_ROOT.test(String(lock.buildchain?.[field] || ""))) {
      failures.push({
        code: `${label}-${field}-invalid`,
        message: `${label} ${field} must be a sha256 root`,
      });
    }
  }
}

function selectorFailure(record, selector) {
  const location = `${record.sourcePath}:${record.line}`;
  if (record.scalarKind === "expression" || selector.includes("${{")) {
    return {
      code: "persistent-selector-indirection",
      message: `${location} uses repository/input/environment indirection for a persisted Buildchain selector`,
    };
  }
  if (EXACT_SHA.test(selector.toLowerCase())) {
    return {
      code: "persistent-exact-sha-selector",
      message: `${location} persists an exact Buildchain SHA; use v4 or v4-alpha plus contract locks`,
    };
  }
  return {
    code: "unapproved-v4-selector",
    message: `${location} uses ${selector || "<empty>"}; approved persisted selectors are v4 and v4-alpha`,
  };
}

function normalizeWorkflowPath(value) {
  const text = String(value || "").replace(/^\/+/, "");
  return text.startsWith(".github/workflows/")
    ? text
    : `.github/workflows/${text}`;
}

function validateScanIdentity(
  { repository, sourceSha, runtimeSha, workflowSha },
  failures,
) {
  const coordinates = [
    [sourceSha, "caller-source-sha-invalid", "caller source SHA"],
    [runtimeSha, "resolved-runtime-sha-invalid", "resolved runtime SHA"],
    [
      workflowSha,
      "resolved-workflow-sha-invalid",
      "resolved workflow shell SHA",
    ],
  ];
  for (const [value, code, label] of coordinates) {
    if (!EXACT_SHA.test(value))
      failures.push({ code, message: `${label} must be an exact commit` });
  }
  if (!repository || !/^[^/]+\/[^/]+$/u.test(repository)) {
    failures.push({
      code: "caller-repository-invalid",
      message: "caller repository must be owner/repo",
    });
  }
}

function readContractLock(root, relative, expectedRef, label, failures) {
  try {
    const lock = readJson(root, relative, `${label} contract lock`).value;
    validateLock(lock, expectedRef, `${label}-lock`, failures);
    return lock;
  } catch (error) {
    failures.push({ code: `${label}-lock-missing`, message: error.message });
    return undefined;
  }
}

function classifyBuildchainUses(records, failures) {
  const uses = [];
  for (const record of records) {
    const parsed = coordinate(record.uses);
    if (!parsed || parsed.repository !== BUILDCHAIN_REPOSITORY) continue;
    const v4Candidate =
      parsed.selector === "v4" ||
      parsed.selector === "v4-alpha" ||
      /^v4(?:[./-]|$)/u.test(parsed.selector) ||
      EXACT_SHA.test(parsed.selector.toLowerCase()) ||
      parsed.selector.includes("${{");
    if (!v4Candidate) continue;
    const channel = CHANNELS[parsed.selector] || "";
    uses.push({
      ...record,
      ...parsed,
      channel,
      selectorClass: channel ? "floating" : "rejected",
    });
    if (!channel) failures.push(selectorFailure(record, parsed.selector));
  }
  return uses;
}

function selectInvocation(buildchainUses, invokedWorkflow, failures) {
  const expectedWorkflow = normalizeWorkflowPath(invokedWorkflow);
  const invocations = buildchainUses.filter(
    (entry) => normalizeWorkflowPath(entry.path) === expectedWorkflow,
  );
  if (invocations.length !== 1) {
    failures.push({
      code: invocations.length
        ? "invoked-workflow-ambiguous"
        : "invoked-workflow-not-found",
      message: `caller source must contain exactly one ${expectedWorkflow} Buildchain v4 invocation`,
    });
  }
  return { expectedWorkflow, selected: invocations[0] };
}

export function scanV4FloatingConsumerPolicy({
  root = process.cwd(),
  repository = "",
  sourceSha = "",
  invokedWorkflow = "",
  resolvedWorkflowSha = "",
  resolvedRuntimeSha = "",
  stableLockPath = ".buildchain/contract-lock.json",
  alphaLockPath = ".buildchain/alpha-contract-lock.json",
  policy,
  scannerRoot = "",
} = {}) {
  const resolvedRoot = path.resolve(root);
  if (!policy || policy.contract !== V4_FLOATING_CONSUMER_POLICY) {
    throw new Error(`policy must use ${V4_FLOATING_CONSUMER_POLICY}`);
  }
  const failures = [];
  const normalizedSourceSha = String(sourceSha || "").toLowerCase();
  const normalizedRuntimeSha = String(resolvedRuntimeSha || "").toLowerCase();
  const normalizedWorkflowSha = String(
    resolvedWorkflowSha || resolvedRuntimeSha || "",
  ).toLowerCase();
  validateScanIdentity(
    {
      repository,
      sourceSha: normalizedSourceSha,
      runtimeSha: normalizedRuntimeSha,
      workflowSha: normalizedWorkflowSha,
    },
    failures,
  );
  const stable = readContractLock(
    resolvedRoot,
    stableLockPath,
    "v4",
    "stable",
    failures,
  );
  const alpha = readContractLock(
    resolvedRoot,
    alphaLockPath,
    "v4-alpha",
    "alpha",
    failures,
  );

  let scanned = { files: [], records: [] };
  try {
    scanned = enumerateUses(resolvedRoot);
  } catch (error) {
    failures.push({ code: "source-scan-failed", message: error.message });
  }
  const buildchainUses = classifyBuildchainUses(scanned.records, failures);
  const { expectedWorkflow, selected } = selectInvocation(
    buildchainUses,
    invokedWorkflow,
    failures,
  );
  const selectedLock = selected?.channel === "alpha" ? alpha : stable;
  if (
    selected?.channel &&
    selectedLock?.buildchain?.resolvedSha?.toLowerCase() !==
      normalizedWorkflowSha
  ) {
    failures.push({
      code: "selected-lock-runtime-mismatch",
      message: `${selected.channel} contract lock does not bind resolved workflow shell ${normalizedWorkflowSha}`,
    });
  }

  const policyRoot = sha256(stableJson(policy));
  const resolvedScannerRoot = scannerRoot || policyRoot;
  if (!SHA256_ROOT.test(resolvedScannerRoot)) {
    failures.push({
      code: "scanner-root-invalid",
      message: "scanner root must be a sha256 root",
    });
  }
  const contractLockRoots = {
    stable: stable ? sha256(stableJson(stable)) : "",
    alpha: alpha ? sha256(stableJson(alpha)) : "",
  };
  const scanRoot = sha256(
    stableJson({ files: scanned.files, invocations: buildchainUses }),
  );
  const receipt = {
    schema: V4_FLOATING_CONSUMER_RECEIPT,
    status: failures.length ? "failed" : "passed",
    caller: { repository, sourceSha: normalizedSourceSha },
    invocation: {
      workflow: expectedWorkflow,
      sourcePath: selected?.sourcePath || "",
      sourceLine: selected?.line || 0,
      visibleSelector: selected?.selector || "",
      selectorClass: selected?.selectorClass || "",
      channel: selected?.channel || "",
      resolvedWorkflowSha: normalizedWorkflowSha,
      resolvedRuntimeSha: normalizedRuntimeSha,
    },
    contractLocks: {
      stable: { path: stableLockPath, root: contractLockRoots.stable },
      alpha: { path: alphaLockPath, root: contractLockRoots.alpha },
    },
    policy: {
      version: policy.policyVersion,
      root: policyRoot,
      scannerRoot: resolvedScannerRoot,
      sourceScanRoot: scanRoot,
    },
    failures,
  };
  const receiptRoot = sha256(stableJson(receipt));
  return {
    schema: "kungfu-buildchain-v4-floating-consumer-policy-check/v1",
    ok: failures.length === 0,
    failures,
    scannedFiles: scanned.files,
    invocations: buildchainUses,
    receipt,
    receiptRoot,
  };
}

export function verifyV4FloatingConsumerPolicyReceipt({
  receipt,
  receiptRoot = "",
  repository = "",
  sourceSha = "",
  invokedWorkflow = "",
  resolvedRuntimeSha = "",
  policyRoot = "",
  scannerRoot = "",
  stableLockRoot = "",
  alphaLockRoot = "",
} = {}) {
  const failures = [];
  const check = (condition, code, message) => {
    if (!condition) failures.push({ code, message });
  };
  check(
    receipt?.schema === V4_FLOATING_CONSUMER_RECEIPT,
    "receipt-contract-invalid",
    `receipt must use ${V4_FLOATING_CONSUMER_RECEIPT}`,
  );
  check(
    receipt?.status === "passed",
    "receipt-not-passed",
    "policy receipt status must be passed",
  );
  check(
    Array.isArray(receipt?.failures) && receipt.failures.length === 0,
    "receipt-retains-failures",
    "passed receipt must not retain failures",
  );
  const computedRoot = receipt ? sha256(stableJson(receipt)) : "";
  check(
    !receiptRoot || receiptRoot === computedRoot,
    "receipt-root-mismatch",
    "policy receipt root does not match its content",
  );
  if (repository)
    check(
      receipt?.caller?.repository === repository,
      "caller-repository-mismatch",
      "policy receipt caller repository mismatch",
    );
  if (sourceSha)
    check(
      receipt?.caller?.sourceSha === sourceSha.toLowerCase(),
      "caller-source-mismatch",
      "policy receipt caller source mismatch",
    );
  if (invokedWorkflow)
    check(
      receipt?.invocation?.workflow === normalizeWorkflowPath(invokedWorkflow),
      "invoked-workflow-mismatch",
      "policy receipt workflow mismatch",
    );
  if (resolvedRuntimeSha)
    check(
      receipt?.invocation?.resolvedRuntimeSha ===
        resolvedRuntimeSha.toLowerCase(),
      "runtime-sha-mismatch",
      "policy receipt runtime SHA mismatch",
    );
  if (policyRoot)
    check(
      receipt?.policy?.root === policyRoot,
      "policy-root-mismatch",
      "policy receipt policy root mismatch",
    );
  if (scannerRoot)
    check(
      receipt?.policy?.scannerRoot === scannerRoot,
      "scanner-root-mismatch",
      "policy receipt scanner root mismatch",
    );
  if (stableLockRoot)
    check(
      receipt?.contractLocks?.stable?.root === stableLockRoot,
      "stable-lock-root-mismatch",
      "policy receipt stable lock root mismatch",
    );
  if (alphaLockRoot)
    check(
      receipt?.contractLocks?.alpha?.root === alphaLockRoot,
      "alpha-lock-root-mismatch",
      "policy receipt alpha lock root mismatch",
    );
  check(
    receipt?.invocation?.selectorClass === "floating",
    "selector-class-invalid",
    "policy receipt must bind a floating selector",
  );
  check(
    ["v4", "v4-alpha"].includes(receipt?.invocation?.visibleSelector),
    "selector-invalid",
    "policy receipt selector must be v4 or v4-alpha",
  );
  return { ok: failures.length === 0, failures, receiptRoot: computedRoot };
}

export function certifyV4FloatingConsumerPolicyReceipt(options = {}) {
  const verification = verifyV4FloatingConsumerPolicyReceipt(options);
  const certification = {
    schema: V4_FLOATING_CONSUMER_CERTIFICATION,
    status: verification.ok ? "certified" : "rejected",
    receiptRoot: verification.receiptRoot,
    caller: options.receipt?.caller || {},
    invocation: options.receipt?.invocation || {},
    policy: options.receipt?.policy || {},
    contractLocks: options.receipt?.contractLocks || {},
    failures: verification.failures,
  };
  return {
    ok: verification.ok,
    verification,
    certification,
    certificationRoot: sha256(stableJson(certification)),
  };
}

export function verifyV4FloatingConsumerPolicyCertification({
  certification,
  certificationRoot = "",
  repository = "",
  sourceSha = "",
  invokedWorkflow = "",
  resolvedRuntimeSha = "",
  policyRoot = "",
  scannerRoot = "",
  stableLockRoot = "",
  alphaLockRoot = "",
} = {}) {
  const failures = [];
  const check = (condition, code, message) => {
    if (!condition) failures.push({ code, message });
  };
  check(
    certification?.schema === V4_FLOATING_CONSUMER_CERTIFICATION,
    "certification-contract-invalid",
    `certification must use ${V4_FLOATING_CONSUMER_CERTIFICATION}`,
  );
  check(
    certification?.status === "certified",
    "certification-not-certified",
    "certification status must be certified",
  );
  check(
    Array.isArray(certification?.failures) &&
      certification.failures.length === 0,
    "certification-retains-failures",
    "certified evidence must not retain failures",
  );
  const computedRoot = certification ? sha256(stableJson(certification)) : "";
  check(
    !certificationRoot || certificationRoot === computedRoot,
    "certification-root-mismatch",
    "certification root does not match its content",
  );
  if (repository)
    check(
      certification?.caller?.repository === repository,
      "caller-repository-mismatch",
      "certification caller repository mismatch",
    );
  if (sourceSha)
    check(
      certification?.caller?.sourceSha === sourceSha.toLowerCase(),
      "caller-source-mismatch",
      "certification caller source mismatch",
    );
  if (invokedWorkflow)
    check(
      certification?.invocation?.workflow ===
        normalizeWorkflowPath(invokedWorkflow),
      "invoked-workflow-mismatch",
      "certification workflow mismatch",
    );
  if (resolvedRuntimeSha)
    check(
      certification?.invocation?.resolvedRuntimeSha ===
        resolvedRuntimeSha.toLowerCase(),
      "runtime-sha-mismatch",
      "certification runtime SHA mismatch",
    );
  if (policyRoot)
    check(
      certification?.policy?.root === policyRoot,
      "policy-root-mismatch",
      "certification policy root mismatch",
    );
  if (scannerRoot)
    check(
      certification?.policy?.scannerRoot === scannerRoot,
      "scanner-root-mismatch",
      "certification scanner root mismatch",
    );
  if (stableLockRoot)
    check(
      certification?.contractLocks?.stable?.root === stableLockRoot,
      "stable-lock-root-mismatch",
      "certification stable lock root mismatch",
    );
  if (alphaLockRoot)
    check(
      certification?.contractLocks?.alpha?.root === alphaLockRoot,
      "alpha-lock-root-mismatch",
      "certification alpha lock root mismatch",
    );
  check(
    SHA256_ROOT.test(String(certification?.receiptRoot || "")),
    "receipt-root-invalid",
    "certification must bind a receipt root",
  );
  check(
    certification?.invocation?.selectorClass === "floating",
    "selector-class-invalid",
    "certification must bind a floating selector",
  );
  check(
    ["v4", "v4-alpha"].includes(certification?.invocation?.visibleSelector),
    "selector-invalid",
    "certification selector must be v4 or v4-alpha",
  );
  return {
    ok: failures.length === 0,
    failures,
    certificationRoot: computedRoot,
  };
}
