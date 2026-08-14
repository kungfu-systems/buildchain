import crypto from "node:crypto";

export const V4_FLOATING_CONSUMER_POLICY =
  "kungfu-buildchain-v4-floating-consumer-policy/v1";
export const V4_FLOATING_CONSUMER_RECEIPT =
  "kungfu-buildchain-v4-floating-consumer-policy-receipt/v1";
export const V4_FLOATING_CONSUMER_CERTIFICATION =
  "kungfu-buildchain-v4-floating-consumer-certification/v1";

const SHA256_ROOT = /^sha256:[0-9a-f]{64}$/u;

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

function documentRoot(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(stableJson(value))
    .digest("hex")}`;
}

function normalizeWorkflowPath(value) {
  const text = String(value || "").replace(/^\/+/, "");
  return text.startsWith(".github/workflows/")
    ? text
    : `.github/workflows/${text}`;
}

function checker(failures) {
  return (condition, code, message) => {
    if (!condition) failures.push({ code, message });
  };
}

function verifyIdentity(value, expected, check, label) {
  if (expected.repository)
    check(
      value?.caller?.repository === expected.repository,
      "caller-repository-mismatch",
      `${label} caller repository mismatch`,
    );
  if (expected.sourceSha)
    check(
      value?.caller?.sourceSha === expected.sourceSha.toLowerCase(),
      "caller-source-mismatch",
      `${label} caller source mismatch`,
    );
  if (expected.invokedWorkflow)
    check(
      value?.invocation?.workflow ===
        normalizeWorkflowPath(expected.invokedWorkflow),
      "invoked-workflow-mismatch",
      `${label} workflow mismatch`,
    );
  if (expected.resolvedRuntimeSha)
    check(
      value?.invocation?.resolvedRuntimeSha ===
        expected.resolvedRuntimeSha.toLowerCase(),
      "runtime-sha-mismatch",
      `${label} runtime SHA mismatch`,
    );
}

function verifyAuthorityFields(value, expected, check, label) {
  for (const [field, actual, code, message] of [
    ["policyRoot", value?.policy?.root, "policy-root-mismatch", "policy root"],
    [
      "scannerRoot",
      value?.policy?.scannerRoot,
      "scanner-root-mismatch",
      "scanner root",
    ],
    [
      "stableLockRoot",
      value?.contractLocks?.stable?.root,
      "stable-lock-root-mismatch",
      "stable lock root",
    ],
    [
      "alphaLockRoot",
      value?.contractLocks?.alpha?.root,
      "alpha-lock-root-mismatch",
      "alpha lock root",
    ],
    [
      "stableLockPath",
      value?.contractLocks?.stable?.path,
      "stable-lock-path-mismatch",
      "stable lock path",
    ],
    [
      "alphaLockPath",
      value?.contractLocks?.alpha?.path,
      "alpha-lock-path-mismatch",
      "alpha lock path",
    ],
  ]) {
    if (expected[field])
      check(actual === expected[field], code, `${label} ${message} mismatch`);
  }
}

function verifyFloatingSelector(value, check, label) {
  check(
    value?.invocation?.selectorClass === "floating",
    "selector-class-invalid",
    `${label} must bind a floating selector`,
  );
  check(
    ["v4", "v4-alpha"].includes(value?.invocation?.visibleSelector),
    "selector-invalid",
    `${label} selector must be v4 or v4-alpha`,
  );
}

export function v4FloatingConsumerDocumentRoot(value) {
  return documentRoot(value);
}

export function verifyV4FloatingConsumerPolicyReceipt(options = {}) {
  const { receipt, receiptRoot = "", expectedReceiptRoot = "" } = options;
  const failures = [];
  const check = checker(failures);
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
  const computedRoot = receipt ? documentRoot(receipt) : "";
  check(
    SHA256_ROOT.test(String(receiptRoot || "")),
    "receipt-root-invalid",
    "policy receipt root must be a sha256 root",
  );
  check(
    receiptRoot === computedRoot,
    "receipt-root-mismatch",
    "policy receipt root does not match its content",
  );
  if (expectedReceiptRoot)
    check(
      computedRoot === expectedReceiptRoot,
      "receipt-authority-root-mismatch",
      "policy receipt does not match the independently reconstructed receipt",
    );
  verifyIdentity(receipt, options, check, "policy receipt");
  verifyAuthorityFields(receipt, options, check, "policy receipt");
  verifyFloatingSelector(receipt, check, "policy receipt");
  return { ok: failures.length === 0, failures, receiptRoot: computedRoot };
}

function defaultAuthority(options, receiptRoot) {
  return {
    receiptRoot: options.expectedReceiptRoot || receiptRoot,
    policyRoot: options.policyRoot || "",
    scannerRoot: options.scannerRoot || "",
    contractLocks: {
      stable: {
        path: options.stableLockPath || "",
        root: options.stableLockRoot || "",
      },
      alpha: {
        path: options.alphaLockPath || "",
        root: options.alphaLockRoot || "",
      },
    },
  };
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
    authority:
      options.authority || defaultAuthority(options, verification.receiptRoot),
    failures: verification.failures,
  };
  return {
    ok: verification.ok,
    verification,
    certification,
    certificationRoot: documentRoot(certification),
  };
}

function verifyCertificationAuthority(certification, expected, check) {
  const authority = certification?.authority;
  for (const [value, code, message] of [
    [
      certification?.policy?.root,
      "policy-root-invalid",
      "certified policy root",
    ],
    [
      certification?.policy?.scannerRoot,
      "scanner-root-invalid",
      "certified scanner root",
    ],
    [
      certification?.contractLocks?.stable?.root,
      "stable-lock-root-invalid",
      "certified stable lock root",
    ],
    [
      certification?.contractLocks?.alpha?.root,
      "alpha-lock-root-invalid",
      "certified alpha lock root",
    ],
  ]) {
    check(
      SHA256_ROOT.test(String(value || "")),
      code,
      `${message} must be a sha256 root`,
    );
  }
  check(
    authority?.receiptRoot === certification?.receiptRoot,
    "certification-authority-receipt-mismatch",
    "certification authority must bind the certified receipt root",
  );
  check(
    authority?.policyRoot === certification?.policy?.root,
    "certification-authority-policy-mismatch",
    "certification authority must bind the certified policy root",
  );
  check(
    authority?.scannerRoot === certification?.policy?.scannerRoot,
    "certification-authority-scanner-mismatch",
    "certification authority must bind the certified scanner root",
  );
  for (const channel of ["stable", "alpha"]) {
    check(
      authority?.contractLocks?.[channel]?.path ===
        certification?.contractLocks?.[channel]?.path &&
        authority?.contractLocks?.[channel]?.root ===
          certification?.contractLocks?.[channel]?.root,
      `certification-authority-${channel}-lock-mismatch`,
      `certification authority must bind the certified ${channel} lock`,
    );
  }
  if (expected.expectedReceiptRoot)
    check(
      certification?.receiptRoot === expected.expectedReceiptRoot,
      "receipt-authority-root-mismatch",
      "certification receipt root does not match external authority",
    );
}

export function verifyV4FloatingConsumerPolicyCertification(options = {}) {
  const { certification, certificationRoot = "" } = options;
  const failures = [];
  const check = checker(failures);
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
  const computedRoot = certification ? documentRoot(certification) : "";
  check(
    SHA256_ROOT.test(String(certificationRoot || "")),
    "certification-root-invalid",
    "certification root must be a sha256 root",
  );
  check(
    certificationRoot === computedRoot,
    "certification-root-mismatch",
    "certification root does not match its content",
  );
  if (options.expectedCertificationRoot)
    check(
      certificationRoot === options.expectedCertificationRoot,
      "certification-authority-root-mismatch",
      "certification root does not match the workflow-certified root",
    );
  check(
    SHA256_ROOT.test(String(certification?.receiptRoot || "")),
    "receipt-root-invalid",
    "certification must bind a receipt root",
  );
  verifyIdentity(certification, options, check, "certification");
  verifyAuthorityFields(certification, options, check, "certification");
  verifyCertificationAuthority(certification, options, check);
  verifyFloatingSelector(certification, check, "certification");
  return {
    ok: failures.length === 0,
    failures,
    certificationRoot: computedRoot,
  };
}
