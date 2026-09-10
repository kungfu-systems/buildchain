import { adopterDeliveryGateDigest } from "./adopter-delivery-json.js";

export const CROSS_PLATFORM_ADOPTER_REPORT_CONTRACT =
  "kungfu-buildchain-v4-cross-platform-adopter-report/v1";
export const CROSS_PLATFORM_ADOPTER_QUALIFICATION_CONTRACT =
  "kungfu-buildchain-v4-cross-platform-adopter-qualification/v1";
export const CROSS_PLATFORM_ADOPTER_PLATFORMS = Object.freeze([
  "linux-x64",
  "macos-arm64",
  "windows-x64",
]);
export const CROSS_PLATFORM_NEUTRAL_DRIVER = "ledger-specification-driver";

const SHA = /^[0-9a-f]{40}$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const CONSUMER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function fail(message) {
  throw new Error(`v4 cross-platform adopter qualification: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fail(`${label} has an unsupported field set`);
  return value;
}

function same(left, right) {
  return adopterDeliveryGateDigest(left) === adopterDeliveryGateDigest(right);
}

function validateSourceBinding(binding) {
  exactKeys(
    binding,
    ["runtimeSha", "consumerSha", "inputRoot"],
    "source binding",
  );
  if (
    !SHA.test(binding.runtimeSha || "") ||
    !SHA.test(binding.consumerSha || "") ||
    !ROOT.test(binding.inputRoot || "")
  )
    fail("report requires exact runtime, consumer and input roots");
}

function validateExecutionEvidence(execution) {
  exactKeys(
    execution,
    [
      "initialRun",
      "tamperFailure",
      "retryRun",
      "terminalVerify",
      "neutralDriver",
    ],
    "execution evidence",
  );
  const complete =
    execution.initialRun?.status === "passed" &&
    ROOT.test(execution.initialRun?.readbackRoot || "") &&
    execution.tamperFailure?.status === "failed-as-required" &&
    Number.isSafeInteger(execution.tamperFailure?.exitCode) &&
    execution.tamperFailure.exitCode > 0 &&
    execution.retryRun?.status === "passed" &&
    execution.retryRun?.readbackRoot === execution.initialRun.readbackRoot &&
    execution.terminalVerify?.status === "passed" &&
    execution.terminalVerify?.readbackRoot ===
      execution.retryRun.readbackRoot &&
    execution.neutralDriver?.id === CROSS_PLATFORM_NEUTRAL_DRIVER &&
    execution.neutralDriver?.status === "passed" &&
    execution.neutralDriver?.kfdDependencyPresent === false;
  if (!complete)
    fail("failure, retry, terminal or neutral-driver evidence is incomplete");
}

function validateAuthorityCeiling(authority) {
  exactKeys(
    authority,
    [
      "productionWrites",
      "providerEffects",
      "releaseEffects",
      "stablePublication",
    ],
    "authority ceiling",
  );
  if (Object.values(authority).some((value) => value !== false))
    fail("qualification report must not grant production or release authority");
}

export function validateCrossPlatformAdopterReport(report) {
  exactKeys(
    report,
    [
      "schemaVersion",
      "contract",
      "platform",
      "consumer",
      "sourceBinding",
      "execution",
      "authority",
      "reportRoot",
    ],
    "platform report",
  );
  if (
    report.schemaVersion !== 1 ||
    report.contract !== CROSS_PLATFORM_ADOPTER_REPORT_CONTRACT
  )
    fail("platform report contract is unsupported");
  if (!CROSS_PLATFORM_ADOPTER_PLATFORMS.includes(report.platform))
    fail(`undeclared platform ${report.platform}`);
  if (!CONSUMER.test(report.consumer || ""))
    fail("consumer must be a stable lowercase identity");
  validateSourceBinding(report.sourceBinding);
  validateExecutionEvidence(report.execution);
  validateAuthorityCeiling(report.authority);
  if (!ROOT.test(report.reportRoot || "")) fail("report root is invalid");
  const body = structuredClone(report);
  delete body.reportRoot;
  if (adopterDeliveryGateDigest(body) !== report.reportRoot)
    fail("report root does not match exact report bytes");
  return structuredClone(report);
}

export function createCrossPlatformAdopterReport(input) {
  const body = structuredClone(input);
  const report = {
    schemaVersion: 1,
    contract: CROSS_PLATFORM_ADOPTER_REPORT_CONTRACT,
    ...body,
  };
  report.reportRoot = adopterDeliveryGateDigest(report);
  return validateCrossPlatformAdopterReport(report);
}

export function qualifyCrossPlatformAdopters({ reports, consumers }) {
  if (!Array.isArray(reports) || reports.length === 0)
    fail("at least one raw platform report is required");
  if (
    !Array.isArray(consumers) ||
    consumers.length === 0 ||
    consumers.some((consumer) => !CONSUMER.test(consumer)) ||
    new Set(consumers).size !== consumers.length
  )
    fail("required consumers must be unique stable lowercase identities");
  const normalized = reports.map(validateCrossPlatformAdopterReport);
  const expectedKeys = consumers.flatMap((consumer) =>
    CROSS_PLATFORM_ADOPTER_PLATFORMS.map(
      (platform) => `${consumer}:${platform}`,
    ),
  );
  const reportByKey = new Map();
  for (const report of normalized) {
    const key = `${report.consumer}:${report.platform}`;
    if (reportByKey.has(key)) fail(`duplicate report ${key}`);
    reportByKey.set(key, report);
  }
  const missing = expectedKeys.filter((key) => !reportByKey.has(key));
  const unexpected = [...reportByKey.keys()].filter(
    (key) => !expectedKeys.includes(key),
  );
  if (missing.length || unexpected.length)
    fail(
      `platform matrix mismatch; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
    );
  const reference = normalized[0].sourceBinding;
  for (const report of normalized.slice(1)) {
    if (
      report.sourceBinding.runtimeSha !== reference.runtimeSha
    )
      fail("all platform reports must bind the same exact source and matrix");
  }
  for (const consumer of consumers) {
    const rows = normalized.filter(report => report.consumer === consumer);
    if (rows.some(report => !same(report.sourceBinding, rows[0].sourceBinding)))
      fail("each consumer must bind the same exact source and input on every platform");
  }
  const orderedReports = expectedKeys.map((key) => reportByKey.get(key));
  const body = {
    schemaVersion: 1,
    contract: CROSS_PLATFORM_ADOPTER_QUALIFICATION_CONTRACT,
    sourceBinding: {
      runtimeSha: reference.runtimeSha,
    },
    consumers: [...consumers],
    platforms: [...CROSS_PLATFORM_ADOPTER_PLATFORMS],
    reports: orderedReports.map(({ consumer, platform, reportRoot, sourceBinding }) => ({
      consumer,
      platform,
      reportRoot,
      sourceBinding: structuredClone(sourceBinding),
    })),
    neutralDriver: {
      id: CROSS_PLATFORM_NEUTRAL_DRIVER,
      platformCoverage: [...CROSS_PLATFORM_ADOPTER_PLATFORMS],
      status: "passed",
    },
    authority: {
      productionWrites: false,
      providerEffects: false,
      releaseEffects: false,
      stablePublication: false,
    },
  };
  return {
    ...body,
    qualificationRoot: adopterDeliveryGateDigest(body),
  };
}
