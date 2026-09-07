import crypto from "node:crypto";

import {
  domainContentRoot,
  validateClock,
  validateRoot,
} from "./canonical-contracts.js";
import {
  DELIVERY_WARRANT_PROJECTION_CONTRACT,
  DELIVERY_WARRANT_RUNNER_CONTRACT,
  DELIVERY_WARRANT_TRACE_CONTRACT,
} from "./delivery-warrant-fixture-runner.js";
import {
  DELIVERY_WARRANT_SHADOW_OBSERVATION_CONTRACT,
  runDeliveryWarrantShadow,
} from "./delivery-warrant-shadow-adapter.js";

export const DELIVERY_WARRANT_SEMANTIC_DIFF_REPORT_CONTRACT =
  "buildchain-v4-delivery-warrant-semantic-diff-report/v1";
export const DELIVERY_WARRANT_SEMANTIC_DIFF_VALIDATOR_VERSION =
  "semantic-diff-gate-v1";
export const DELIVERY_WARRANT_SEMANTIC_DIFF_REQUIRED_COVERAGE = Object.freeze([
  "cancellation",
  "cas",
  "conflict",
  "duplicate",
  "golden",
  "lease-fence",
  "property",
  "replay",
  "response-loss",
]);

const REVISION = /^[0-9a-f]{40,64}$/u;
const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const stop = (code) => ({ code, retry: "stop" });
const valueRoot = (value) =>
  value === undefined ? null : domainContentRoot("semantic-diff", { value });

function difference(path, kind, legacy, rust) {
  const summary = {
    path,
    kind,
    legacyRoot: valueRoot(legacy),
    rustRoot: valueRoot(rust),
  };
  return {
    ...summary,
    differenceRoot: domainContentRoot("semantic-diff", summary),
  };
}

export function compareDeliveryWarrantSemantics(legacy, rust, path = "$") {
  if (Object.is(legacy, rust)) return [];
  if (legacy === undefined)
    return [difference(path, "missing-legacy", legacy, rust)];
  if (rust === undefined)
    return [difference(path, "missing-rust", legacy, rust)];
  if (
    legacy === null ||
    rust === null ||
    typeof legacy !== "object" ||
    typeof rust !== "object" ||
    Array.isArray(legacy) !== Array.isArray(rust)
  )
    return [difference(path, "value-mismatch", legacy, rust)];
  const keys = Array.isArray(legacy)
    ? Array.from({ length: Math.max(legacy.length, rust.length) }, (_, i) => i)
    : [...new Set([...Object.keys(legacy), ...Object.keys(rust)])].sort();
  return keys.flatMap((key) =>
    compareDeliveryWarrantSemantics(legacy[key], rust[key], `${path}/${key}`),
  );
}

export function deliveryWarrantDispositionRoot(value) {
  return domainContentRoot("semantic-diff", {
    differenceRoot: value.differenceRoot,
    disposition: value.disposition,
    reasonCode: value.reasonCode,
    reviewRoot: value.reviewRoot,
  });
}

function dispositions(values = []) {
  return new Map(
    values.map((value) => {
      validateRoot(value.differenceRoot);
      validateRoot(value.reviewRoot);
      validateRoot(value.dispositionRoot);
      if (
        value.disposition !== "reviewed-exclusion" ||
        !TOKEN.test(value.reasonCode) ||
        value.dispositionRoot !== deliveryWarrantDispositionRoot(value)
      )
        throw new TypeError(
          "semantic difference disposition is not review-rooted",
        );
      return [value.differenceRoot, value];
    }),
  );
}

function bytes(value) {
  if (typeof value === "string") return Buffer.from(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return Buffer.from(value);
  throw new TypeError("semantic diff input must be retained bytes");
}

function classify(entries, index) {
  return entries.map((entry) => {
    const reviewed = index.get(entry.differenceRoot);
    return reviewed
      ? {
          ...entry,
          classification: "reviewed-exclusion",
          dispositionRoot: reviewed.dispositionRoot,
          reasonCode: reviewed.reasonCode,
          reviewRoot: reviewed.reviewRoot,
        }
      : { ...entry, classification: "unexplained" };
  });
}

async function projectCase(definition, options, dispositionIndex) {
  if (!TOKEN.test(definition.id) || !Array.isArray(definition.coverage))
    throw new TypeError(
      "semantic diff case identity and coverage are required",
    );
  const input = bytes(definition.bytes);
  const inputRoot = `sha256:${crypto.createHash("sha256").update(input).digest("hex")}`;
  const result = await options.runShadow(input, {
    enabled: true,
    requestId: `semantic-diff-${definition.id}`,
    recordedAt: options.recordedAt,
    timeoutMs: 30_000,
    retention: definition.retention || { kind: "fixture" },
    retain: options.retainObservation,
    sources: options.sources,
  });
  const observation = result.shadow?.observation;
  const blockers = [];
  if (result.shadow?.status !== "observed" || !observation)
    blockers.push(stop("missing-observation"));
  if (
    observation &&
    (observation.schema !== DELIVERY_WARRANT_SHADOW_OBSERVATION_CONTRACT ||
      observation.authority !== "typescript-v3" ||
      observation.rustAuthority !== "none" ||
      observation.rustEffects !== "disabled")
  )
    blockers.push(stop("authority-mismatch"));
  if (
    observation &&
    (observation.input?.root !== inputRoot ||
      result.shadow?.inputRoot !== inputRoot)
  )
    blockers.push(stop("input-binding-mismatch"));
  if (observation && observation.retention?.publicSafe !== true)
    blockers.push(stop("input-not-public-safe"));
  if (result.shadow?.retention?.status !== "retained")
    blockers.push(stop("retention-failed"));
  if (
    observation &&
    Object.keys(options.sources).some(
      (key) => observation.sources?.[key] !== options.sources[key],
    )
  )
    blockers.push(stop("source-binding-mismatch"));
  const rust = observation?.rust?.projection;
  const differences = classify(
    rust
      ? compareDeliveryWarrantSemantics(result.authoritativeResult, rust)
      : [],
    dispositionIndex,
  );
  if (differences.some((entry) => entry.classification === "unexplained"))
    blockers.push(stop("unexplained-difference"));
  const evidence = {
    id: definition.id,
    coverage: [...new Set(definition.coverage)].sort(),
    inputRoot,
    observationRoot: observation
      ? domainContentRoot("semantic-diff", observation)
      : null,
    legacyProjectionRoot: result.authoritativeResult?.projectionRoot || null,
    rustProjectionRoot: rust?.projectionRoot || null,
    differences,
    differenceRoot: domainContentRoot("semantic-diff", differences),
    blockers,
  };
  return {
    report: {
      ...evidence,
      evidenceRoot: domainContentRoot("semantic-diff", evidence),
      status: blockers.length ? "blocked" : "zero-unexplained-diff",
    },
    legacy: result.authoritativeResult,
    rust,
  };
}

function inject(value, probe) {
  const clone = structuredClone(value);
  const parts = probe.path.slice(2).split("/");
  const leaf = parts.pop();
  const parent = parts.reduce((node, part) => node?.[part], clone);
  if (!parent || !(leaf in parent))
    throw new TypeError("fault probe path is absent");
  if (probe.operation === "remove") delete parent[leaf];
  else if (probe.operation === "replace") parent[leaf] = probe.value;
  else throw new TypeError("fault probe operation is invalid");
  return clone;
}

function probeReceipts(probes, runtime) {
  if (!Array.isArray(probes) || probes.length < 1 || probes.length > 32)
    throw new RangeError("fault probes must contain 1-32 entries");
  return probes.map((probe) => {
    const target = runtime.get(probe.caseId);
    const differences = target?.rust
      ? compareDeliveryWarrantSemantics(
          target.legacy,
          inject(target.rust, probe),
        )
      : [];
    const receipt = {
      id: probe.id,
      caseId: probe.caseId,
      operation: probe.operation,
      path: probe.path,
      detected: differences.length > 0,
      differenceRoots: differences.map((entry) => entry.differenceRoot).sort(),
    };
    return {
      ...receipt,
      receiptRoot: domainContentRoot("semantic-diff", receipt),
    };
  });
}

export async function runDeliveryWarrantSemanticDiffGate(cases, options = {}) {
  validateClock(options.recordedAt);
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 64)
    throw new RangeError("semantic diff cases must contain 1-64 entries");
  if (
    !REVISION.test(options.sources?.typescriptRevision) ||
    !REVISION.test(options.sources?.rustRevision) ||
    !TOKEN.test(options.sources?.validatorVersion)
  )
    throw new TypeError("semantic diff source binding is invalid");
  for (const key of ["traceSchemaRoot", "reportSchemaRoot", "runnerRoot"])
    validateRoot(options.contracts?.[key]);
  const index = dispositions(options.dispositions);
  const projected = [];
  for (const entry of cases)
    projected.push(
      await projectCase(
        entry,
        {
          ...options,
          runShadow: options.runShadow || runDeliveryWarrantShadow,
        },
        index,
      ),
    );
  const runtime = new Map(projected.map((entry, i) => [cases[i].id, entry]));
  const receipts = probeReceipts(options.faultProbes, runtime);
  const coverage = new Set(cases.flatMap((entry) => entry.coverage));
  const missing = DELIVERY_WARRANT_SEMANTIC_DIFF_REQUIRED_COVERAGE.filter(
    (entry) => !coverage.has(entry),
  );
  const blockers = projected.flatMap((entry) => entry.report.blockers);
  if (missing.length) blockers.push(stop("coverage-incomplete"));
  if (receipts.some((entry) => !entry.detected))
    blockers.push(stop("fault-injection-undetected"));
  const body = {
    schema: DELIVERY_WARRANT_SEMANTIC_DIFF_REPORT_CONTRACT,
    authority: "typescript-v3",
    rustAuthority: "none",
    rustEffects: "disabled",
    recordedAt: options.recordedAt,
    retainUntil: new Date(
      Date.parse(options.recordedAt) + 90 * 86400_000,
    ).toISOString(),
    sources: options.sources,
    contracts: {
      trace: DELIVERY_WARRANT_TRACE_CONTRACT,
      projection: DELIVERY_WARRANT_PROJECTION_CONTRACT,
      observation: DELIVERY_WARRANT_SHADOW_OBSERVATION_CONTRACT,
      runner: DELIVERY_WARRANT_RUNNER_CONTRACT,
      ...options.contracts,
    },
    coverage: {
      required: [...DELIVERY_WARRANT_SEMANTIC_DIFF_REQUIRED_COVERAGE],
      observed: [...coverage].sort(),
      missing,
    },
    cases: projected.map((entry) => entry.report),
    faultInjection: { bounded: true, maximumProbes: 32, receipts },
    stopPolicy: {
      retryBudget: 0,
      conditions: [
        "authority-mismatch",
        "coverage-incomplete",
        "fault-injection-undetected",
        "input-binding-mismatch",
        "input-not-public-safe",
        "missing-observation",
        "retention-failed",
        "source-binding-mismatch",
        "unexplained-difference",
      ],
    },
  };
  let retention = {
    status: "failed",
    evidenceRoot: domainContentRoot("semantic-diff", body),
    receiptRoot: null,
  };
  try {
    const receipt = await options.retain?.(structuredClone(body));
    validateRoot(receipt?.receiptRoot);
    retention = {
      ...retention,
      status: "retained",
      receiptRoot: receipt.receiptRoot,
    };
  } catch {
    blockers.push(stop("retention-failed"));
  }
  const unique = [
    ...new Map(blockers.map((entry) => [entry.code, entry])).values(),
  ].sort((a, b) => (a.code < b.code ? -1 : 1));
  const report = {
    ...body,
    retention,
    blockers: unique,
    verdict: {
      status: unique.length ? "blocked" : "qualified",
      zeroUnexplainedDifferences: !projected.some((entry) =>
        entry.report.differences.some(
          (diff) => diff.classification === "unexplained",
        ),
      ),
      nextEligibleStage: unique.length ? null : "legacy-authoritative-v4-read",
      v4WriteAuthorized: false,
    },
  };
  return { ...report, reportRoot: domainContentRoot("semantic-diff", report) };
}
