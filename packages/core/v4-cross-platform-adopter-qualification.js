import { adopterDeliveryGateDigest } from "./adopter-delivery-json.js";

export const V4_CROSS_PLATFORM_ADOPTER_REPORT_CONTRACT =
  "kungfu-buildchain-v4-cross-platform-adopter-report/v1";
export const V4_CROSS_PLATFORM_ADOPTER_QUALIFICATION_CONTRACT =
  "kungfu-buildchain-v4-cross-platform-adopter-qualification/v1";
export const V4_CROSS_PLATFORM_ADOPTER_PLATFORMS = Object.freeze([
  "linux-x64",
  "macos-arm64",
  "windows-x64",
]);
export const V4_CROSS_PLATFORM_NEUTRAL_DRIVER = "ledger-specification-driver";

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

export function summarizeV3V4CapabilityInventory(inventory) {
  exactKeys(
    inventory,
    [
      "capabilities",
      "contract",
      "extraction",
      "reverseHistory",
      "schemaVersion",
      "sourceCuts",
      "summary",
    ],
    "capability inventory",
  );
  if (
    inventory.schemaVersion !== 1 ||
    inventory.contract !==
      "kungfu-buildchain-v3-v4-live-capability-inventory" ||
    !Array.isArray(inventory.capabilities) ||
    inventory.capabilities.length === 0
  )
    fail("capability inventory contract is unsupported");

  const categoryCounts = {};
  const dispositionCounts = {};
  const ids = new Set();
  for (const [index, capability] of inventory.capabilities.entries()) {
    if (
      !capability ||
      typeof capability !== "object" ||
      typeof capability.id !== "string" ||
      typeof capability.category !== "string" ||
      typeof capability.disposition !== "string" ||
      !capability.sourceEvidence ||
      !capability.v4Route ||
      typeof capability.v4Route.capabilityId !== "string" ||
      capability.v4Route.capabilityId.length === 0 ||
      !capability.v4Route.evidence ||
      capability.residual !== null
    )
      fail(
        `capability ${index} does not bind an exact v3 source to a v4 route`,
      );
    if (ids.has(capability.id))
      fail(`duplicate capability id ${capability.id}`);
    ids.add(capability.id);
    categoryCounts[capability.category] =
      (categoryCounts[capability.category] || 0) + 1;
    dispositionCounts[capability.disposition] =
      (dispositionCounts[capability.disposition] || 0) + 1;
  }
  const summary = {
    capabilityCount: inventory.capabilities.length,
    categoryCounts: Object.fromEntries(
      Object.entries(categoryCounts).sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      ),
    ),
    dispositionCounts: Object.fromEntries(
      Object.entries(dispositionCounts).sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      ),
    ),
    residualCount: 0,
    unknownCount: 0,
    unownedCount: 0,
  };
  if (!same(summary, inventory.summary))
    fail("capability inventory summary does not match its raw rows");
  return {
    inventoryRoot: adopterDeliveryGateDigest(inventory),
    sourceCuts: structuredClone(inventory.sourceCuts),
    summary,
    categories: Object.entries(summary.categoryCounts).map(
      ([category, count]) => ({
        category,
        count,
        applicability: "exact-source-route",
        status: "passed",
      }),
    ),
  };
}

function validateSourceBinding(binding) {
  exactKeys(
    binding,
    ["runtimeSha", "consumerSha", "inventoryRoot", "sourceCuts"],
    "source binding",
  );
  if (
    !SHA.test(binding.runtimeSha || "") ||
    !SHA.test(binding.consumerSha || "") ||
    !ROOT.test(binding.inventoryRoot || "")
  )
    fail("report requires exact runtime, consumer and inventory roots");
}

function completeCategory(entry, counts) {
  return (
    entry &&
    typeof entry.category === "string" &&
    Number.isSafeInteger(entry.count) &&
    entry.count > 0 &&
    entry.applicability === "exact-source-route" &&
    entry.status === "passed" &&
    counts[entry.category] === entry.count
  );
}

function sumCounts(counts) {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

function validateCapabilityMatrix(matrix) {
  exactKeys(
    matrix,
    ["capabilityCount", "categoryCounts", "dispositionCounts", "categories"],
    "capability matrix",
  );
  const complete =
    Number.isSafeInteger(matrix.capabilityCount) &&
    matrix.capabilityCount > 0 &&
    Array.isArray(matrix.categories) &&
    matrix.categories.length > 0 &&
    matrix.categories.every((entry) =>
      completeCategory(entry, matrix.categoryCounts),
    ) &&
    Object.keys(matrix.categoryCounts).length === matrix.categories.length &&
    sumCounts(matrix.categoryCounts) === matrix.capabilityCount &&
    sumCounts(matrix.dispositionCounts) === matrix.capabilityCount;
  if (!complete)
    fail("platform report does not carry the complete raw capability matrix");
}

function validateExecutionEvidence(execution) {
  exactKeys(
    execution,
    [
      "initialRun",
      "tamperFailure",
      "retryRun",
      "terminalVerify",
      "bootstrap",
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
    execution.bootstrap?.status === "passed" &&
    ROOT.test(execution.bootstrap?.resultRoot || "") &&
    execution.neutralDriver?.id === V4_CROSS_PLATFORM_NEUTRAL_DRIVER &&
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

export function validateV4CrossPlatformAdopterReport(report) {
  exactKeys(
    report,
    [
      "schemaVersion",
      "contract",
      "platform",
      "consumer",
      "sourceBinding",
      "capabilityMatrix",
      "execution",
      "authority",
      "reportRoot",
    ],
    "platform report",
  );
  if (
    report.schemaVersion !== 1 ||
    report.contract !== V4_CROSS_PLATFORM_ADOPTER_REPORT_CONTRACT
  )
    fail("platform report contract is unsupported");
  if (!V4_CROSS_PLATFORM_ADOPTER_PLATFORMS.includes(report.platform))
    fail(`undeclared platform ${report.platform}`);
  if (!CONSUMER.test(report.consumer || ""))
    fail("consumer must be a stable lowercase identity");
  validateSourceBinding(report.sourceBinding);
  validateCapabilityMatrix(report.capabilityMatrix);
  validateExecutionEvidence(report.execution);
  validateAuthorityCeiling(report.authority);
  if (!ROOT.test(report.reportRoot || "")) fail("report root is invalid");
  const body = structuredClone(report);
  delete body.reportRoot;
  if (adopterDeliveryGateDigest(body) !== report.reportRoot)
    fail("report root does not match exact report bytes");
  return structuredClone(report);
}

export function createV4CrossPlatformAdopterReport(input) {
  const body = structuredClone(input);
  const report = {
    schemaVersion: 1,
    contract: V4_CROSS_PLATFORM_ADOPTER_REPORT_CONTRACT,
    ...body,
  };
  report.reportRoot = adopterDeliveryGateDigest(report);
  return validateV4CrossPlatformAdopterReport(report);
}

export function qualifyV4CrossPlatformAdopters({ reports, consumers }) {
  if (!Array.isArray(reports) || reports.length === 0)
    fail("at least one raw platform report is required");
  if (
    !Array.isArray(consumers) ||
    consumers.length === 0 ||
    consumers.some((consumer) => !CONSUMER.test(consumer)) ||
    new Set(consumers).size !== consumers.length
  )
    fail("required consumers must be unique stable lowercase identities");
  const normalized = reports.map(validateV4CrossPlatformAdopterReport);
  const expectedKeys = consumers.flatMap((consumer) =>
    V4_CROSS_PLATFORM_ADOPTER_PLATFORMS.map(
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
      report.sourceBinding.runtimeSha !== reference.runtimeSha ||
      report.sourceBinding.inventoryRoot !== reference.inventoryRoot ||
      !same(report.sourceBinding.sourceCuts, reference.sourceCuts) ||
      !same(report.capabilityMatrix, normalized[0].capabilityMatrix)
    )
      fail("all platform reports must bind the same exact source and matrix");
  }
  const orderedReports = expectedKeys.map((key) => reportByKey.get(key));
  const body = {
    schemaVersion: 1,
    contract: V4_CROSS_PLATFORM_ADOPTER_QUALIFICATION_CONTRACT,
    sourceBinding: {
      runtimeSha: reference.runtimeSha,
      inventoryRoot: reference.inventoryRoot,
      sourceCuts: structuredClone(reference.sourceCuts),
    },
    consumers: [...consumers],
    platforms: [...V4_CROSS_PLATFORM_ADOPTER_PLATFORMS],
    capabilityMatrix: structuredClone(normalized[0].capabilityMatrix),
    reports: orderedReports.map(({ consumer, platform, reportRoot }) => ({
      consumer,
      platform,
      reportRoot,
    })),
    neutralDriver: {
      id: V4_CROSS_PLATFORM_NEUTRAL_DRIVER,
      platformCoverage: [...V4_CROSS_PLATFORM_ADOPTER_PLATFORMS],
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
