import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUILDCHAIN_RUNTIME_CONTRACT_WORLD = "kungfu-buildchain-runtime-contract-world";
export const BUILDCHAIN_CONTRACT_LOCK = "kungfu-buildchain-contract-lock";

const DEFAULT_POLICY = "major-compatible";
const FLOATING_CLASSES = new Set(["stable", "alpha"]);

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath, fallback = undefined) {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function maybeFileDigest(root, relPath) {
  const filePath = path.join(root, relPath);
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? `sha256:${sha256File(filePath)}` : "";
}

function surface(root, value) {
  const breakingModel = {
    id: value.id,
    kind: value.kind,
    contractVersion: value.contractVersion || 1,
    requiredInputs: value.requiredInputs || [],
    requiredOutputs: value.requiredOutputs || [],
    breakingDefaults: value.breakingDefaults || {},
    guarantees: value.guarantees || [],
  };
  return {
    contractVersion: 1,
    stability: "stable",
    additiveChanges: "optional inputs, optional outputs, diagnostics, and documentation may be added within the same major line",
    ...value,
    breakingDigest: `sha256:${sha256Json(breakingModel)}`,
    auditDigest: value.path ? maybeFileDigest(root, value.path) : "",
  };
}

function majorLineFromPackageVersion(version = "") {
  const match = String(version || "").match(/^(\d+)\./);
  return match ? `v${match[1]}` : "v2";
}

export function createBuildchainContractWorld({ root = process.cwd(), packageJson = undefined } = {}) {
  const pkg = packageJson || readJson(path.join(root, "package.json"), {});
  const majorLine = majorLineFromPackageVersion(pkg.version);
  const surfaces = [
    surface(root, {
      id: "reusable-build",
      kind: "workflow",
      path: ".github/workflows/.build.yml",
      publicRef: `${pkg.repository ? "kungfu-systems/buildchain" : "buildchain"}/.github/workflows/.build.yml@${majorLine}`,
      requiredInputs: [],
      requiredOutputs: [
        "buildchain-runtime-sha",
        "publish-source-sha",
        "build-summary-artifact",
        "release-candidate-artifact",
      ],
      breakingDefaults: {
        buildchainRefDefault: "workflow-shell-ref-or-v2",
        promoteOnlyHeavyBuildPolicy: "pr-stage-only",
      },
      optionalInputs: [
        "buildchain-ref",
        "runner-preset",
        "platforms-json",
        "release-candidate",
        "artifact-transfer-mode",
        "buildchain-contract-lock-path",
        "buildchain-contract-drift-issue-mode",
      ],
      guarantees: [
        "runtime floating refs are resolved to immutable SHAs before matrix jobs",
        "publish source locks are verified before heavy build jobs",
        "release-candidate builds do not publish registry artifacts",
        "contract drift is checked before heavy build jobs for stable floating refs",
      ],
    }),
    surface(root, {
      id: "release-candidate-promote",
      kind: "workflow",
      path: ".github/workflows/release-candidate-promote.yml",
      publicRef: `${pkg.repository ? "kungfu-systems/buildchain" : "buildchain"}/.github/workflows/release-candidate-promote.yml@${majorLine}`,
      requiredInputs: ["channel"],
      requiredOutputs: ["promoted-sha", "built-source-sha", "release-candidate-artifact"],
      breakingDefaults: {
        promoteOnlyReleaseCandidate: true,
        requiredStatusCheck: "check",
      },
      optionalInputs: [
        "buildchain-ref",
        "release-candidate-workflow-file",
        "release-candidate-workflow-name",
        "publish-required-artifacts-json",
        "release-passport-kfd-1-witness-jsons",
        "buildchain-contract-lock-path",
        "buildchain-contract-drift-issue-mode",
      ],
      guarantees: [
        "promotion reuses PR-stage release-candidate artifacts",
        "promotion does not run the heavy native build matrix",
        "built source and promotion channel SHA are recorded separately",
        "contract drift is checked before release-candidate resolution and publish",
      ],
    }),
    surface(root, {
      id: "promote-buildchain-ref-action",
      kind: "action",
      path: "actions/promote-buildchain-ref/action.yml",
      publicRef: `kungfu-systems/buildchain/actions/promote-buildchain-ref@${majorLine}`,
      requiredInputs: ["token", "sha", "target-ref"],
      requiredOutputs: ["sha"],
      breakingDefaults: {
        requireGovernance: false,
        releasePassport: true,
      },
      optionalInputs: [
        "publish-transaction",
        "publish-required-artifacts-json",
        "promote-only-release-candidate",
        "release-passport-kfd-1-witness-jsons",
      ],
      guarantees: [
        "protected release refs and durable release-state are finalized by Buildchain",
        "release passport finalization is idempotent after publish side effects",
      ],
    }),
    surface(root, {
      id: "report-buildchain-issue-action",
      kind: "action",
      path: "actions/report-buildchain-issue/action.yml",
      publicRef: `kungfu-systems/buildchain/actions/report-buildchain-issue@${majorLine}`,
      requiredInputs: ["token"],
      requiredOutputs: ["ok", "action", "issue-url", "fingerprint"],
      breakingDefaults: {
        failOnError: false,
        mode: "create-or-comment",
      },
      optionalInputs: ["report-kind", "target-repository", "body-file", "comment-cooldown-hours"],
      guarantees: [
        "issue reporting is fail-soft by default",
        "GitHub API 429 and 5xx failures are retried",
        "missing issue permissions produce a copyable summary fallback",
      ],
    }),
    surface(root, {
      id: "release-passport-schema",
      kind: "schema",
      path: "packages/core/release-passport.js",
      requiredInputs: ["buildchain.release.json"],
      requiredOutputs: ["check-report.json"],
      breakingDefaults: {
        schemaVersion: 1,
        contract: "kungfu-buildchain-release-passport",
      },
      guarantees: [
        "release passport verification fails closed for malformed required evidence",
        "release-state SHA is recorded as a durable audit entrance",
      ],
    }),
    surface(root, {
      id: "kfd-1-release-gate",
      kind: "schema",
      path: "packages/core/kfd-gate.js",
      requiredInputs: ["KFD-1 witness JSON"],
      requiredOutputs: ["kfd-1 release gate evidence"],
      breakingDefaults: {
        witnessContract: "kungfu-buildchain-kfd-1-witness-set",
        releaseGateContract: "kungfu-buildchain-kfd-1-release-gate",
      },
      guarantees: [
        "KFD-1 witnesses must include at least one artifact byte surface",
        "artifact bytes are sha256 checked before passport finalization succeeds",
      ],
    }),
    surface(root, {
      id: "buildchain-cli",
      kind: "cli",
      path: "bin/buildchain.mjs",
      requiredInputs: [],
      requiredOutputs: [],
      breakingDefaults: {
        binary: "buildchain",
        moduleSystem: "esm",
      },
      optionalInputs: [
        "validate",
        "lifecycle",
        "collect github-release",
        "verify release-passport",
        "release-propagation",
        "infra-contract",
      ],
      guarantees: [
        "CLI commands are stable within the major line unless the contract major changes",
      ],
    }),
  ];
  const base = {
    schemaVersion: 1,
    contract: BUILDCHAIN_RUNTIME_CONTRACT_WORLD,
    product: {
      name: "Buildchain",
      package: pkg.name || "@kungfu-tech/buildchain",
      version: pkg.version || "",
      repository: pkg.repository?.url || pkg.repository || "https://github.com/kungfu-systems/buildchain",
    },
    majorLine,
    compatibilityPolicy: DEFAULT_POLICY,
    surfaces,
  };
  return finalizeBuildchainContractWorld(base);
}

export function finalizeBuildchainContractWorld(contractWorld) {
  const world = {
    ...contractWorld,
    surfaces: (contractWorld.surfaces || []).map((entry) => ({ ...entry })),
  };
  const compatibilityModel = {
    schemaVersion: world.schemaVersion,
    contract: world.contract,
    majorLine: world.majorLine,
    surfaces: world.surfaces.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      breakingDigest: entry.breakingDigest,
    })),
  };
  const digestModel = {
    ...world,
    contractDigest: undefined,
    compatibilityDigest: undefined,
  };
  world.compatibilityDigest = `sha256:${sha256Json(compatibilityModel)}`;
  world.contractDigest = `sha256:${sha256Json(digestModel)}`;
  return world;
}

export function createBuildchainContractLock({
  buildchainRef = "v2",
  resolvedSha = "",
  contractWorld,
  compatibilityPolicy = DEFAULT_POLICY,
  acceptedAt = new Date().toISOString(),
} = {}) {
  if (!contractWorld || contractWorld.contract !== BUILDCHAIN_RUNTIME_CONTRACT_WORLD) {
    throw new Error("contractWorld must be a Buildchain runtime contract world");
  }
  return {
    schemaVersion: 1,
    contract: BUILDCHAIN_CONTRACT_LOCK,
    buildchain: {
      ref: buildchainRef,
      resolvedSha,
      contract: contractWorld.contract,
      contractDigest: contractWorld.contractDigest,
      compatibilityDigest: contractWorld.compatibilityDigest,
      majorLine: contractWorld.majorLine,
      compatibilityPolicy,
      acceptedAt,
      surfaces: contractWorld.surfaces.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        breakingDigest: entry.breakingDigest,
      })),
    },
  };
}

export function readBuildchainContractWorld(filePath) {
  const value = readJson(filePath);
  if (!value || value.contract !== BUILDCHAIN_RUNTIME_CONTRACT_WORLD) {
    throw new Error(`Buildchain contract world is missing or invalid: ${filePath}`);
  }
  return finalizeBuildchainContractWorld(value);
}

export function readBuildchainContractLock(filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return undefined;
  }
  const value = readJson(filePath);
  if (!value || value.contract !== BUILDCHAIN_CONTRACT_LOCK) {
    throw new Error(`Buildchain contract lock is missing or invalid: ${filePath}`);
  }
  return value;
}

function surfaceMap(surfaces = []) {
  return new Map(surfaces.map((entry) => [entry.id, entry]));
}

export function evaluateBuildchainContractLock({
  lock,
  current,
  runtimeRef = "",
  runtimeSha = "",
  runtimeClass = "",
  compatibilityPolicy = "",
} = {}) {
  if (!current || current.contract !== BUILDCHAIN_RUNTIME_CONTRACT_WORLD) {
    throw new Error("current must be a Buildchain runtime contract world");
  }
  const floatingRuntime = FLOATING_CLASSES.has(runtimeClass);
  if (!floatingRuntime) {
    return {
      ok: true,
      status: "non-floating-runtime",
      drift: false,
      compatible: true,
      issueRecommended: false,
      reason: `runtime class ${runtimeClass || "unknown"} is not a stable floating ref`,
    };
  }
  if (!lock) {
    return {
      ok: true,
      status: "missing-lock",
      drift: false,
      compatible: true,
      issueRecommended: false,
      reason: "consumer repository has no Buildchain contract lock",
    };
  }
  const accepted = lock.buildchain || {};
  const policy = compatibilityPolicy || accepted.compatibilityPolicy || DEFAULT_POLICY;
  const shaDrift = !!accepted.resolvedSha && !!runtimeSha && accepted.resolvedSha !== runtimeSha;
  const contractDrift = !!accepted.contractDigest && accepted.contractDigest !== current.contractDigest;
  if (!shaDrift && !contractDrift) {
    return {
      ok: true,
      status: "unchanged",
      drift: false,
      compatible: true,
      issueRecommended: false,
      policy,
      accepted,
      current: contractSummary(current, runtimeRef, runtimeSha),
    };
  }
  const reasons = [];
  if (accepted.contract !== current.contract) {
    reasons.push(`contract changed from ${accepted.contract || "(unknown)"} to ${current.contract}`);
  }
  if (accepted.majorLine && accepted.majorLine !== current.majorLine) {
    reasons.push(`major line changed from ${accepted.majorLine} to ${current.majorLine}`);
  }
  if (policy === "exact" && accepted.contractDigest !== current.contractDigest) {
    reasons.push("exact policy requires the contract digest to remain unchanged");
  }
  if (!["major-compatible", "allow-additive", "exact"].includes(policy)) {
    reasons.push(`unsupported compatibility policy: ${policy}`);
  }
  const currentSurfaces = surfaceMap(current.surfaces);
  for (const oldSurface of accepted.surfaces || []) {
    const nextSurface = currentSurfaces.get(oldSurface.id);
    if (!nextSurface) {
      reasons.push(`surface removed: ${oldSurface.id}`);
      continue;
    }
    if (nextSurface.breakingDigest !== oldSurface.breakingDigest) {
      reasons.push(`surface breaking digest changed: ${oldSurface.id}`);
    }
  }
  const compatible = reasons.length === 0;
  return {
    ok: compatible,
    status: compatible ? "compatible-drift" : "breaking-drift",
    drift: shaDrift || contractDrift,
    shaDrift,
    contractDrift,
    compatible,
    issueRecommended: true,
    policy,
    reasons,
    accepted,
    current: contractSummary(current, runtimeRef, runtimeSha),
  };
}

export function contractSummary(contractWorld, runtimeRef = "", runtimeSha = "") {
  return {
    ref: runtimeRef,
    resolvedSha: runtimeSha,
    contract: contractWorld.contract,
    contractDigest: contractWorld.contractDigest,
    compatibilityDigest: contractWorld.compatibilityDigest,
    majorLine: contractWorld.majorLine,
    surfaceCount: Array.isArray(contractWorld.surfaces) ? contractWorld.surfaces.length : 0,
  };
}

export function renderBuildchainContractDriftIssueBody({
  repository = "",
  workflow = "",
  runUrl = "",
  lockPath = "",
  evaluation,
} = {}) {
  const accepted = evaluation.accepted || {};
  const current = evaluation.current || {};
  const severity = evaluation.compatible ? "compatible" : "breaking";
  return [
    "# Buildchain contract drift",
    "",
    "## Summary",
    "",
    `Buildchain detected ${severity} contract drift for a floating runtime ref before expensive Buildchain work continued.`,
    "",
    "## Consumer",
    "",
    `- Repository: ${repository || "(unknown)"}`,
    `- Workflow: ${workflow || "(unknown)"}`,
    `- Run: ${runUrl || "(unknown)"}`,
    `- Lock path: ${lockPath || "(unknown)"}`,
    "",
    "## Accepted Buildchain contract",
    "",
    `- Ref: ${accepted.ref || "(unknown)"}`,
    `- SHA: ${accepted.resolvedSha || "(unknown)"}`,
    `- Contract digest: ${accepted.contractDigest || "(unknown)"}`,
    `- Compatibility digest: ${accepted.compatibilityDigest || "(unknown)"}`,
    `- Policy: ${evaluation.policy || accepted.compatibilityPolicy || "(unknown)"}`,
    "",
    "## Current Buildchain contract",
    "",
    `- Ref: ${current.ref || "(unknown)"}`,
    `- SHA: ${current.resolvedSha || "(unknown)"}`,
    `- Contract digest: ${current.contractDigest || "(unknown)"}`,
    `- Compatibility digest: ${current.compatibilityDigest || "(unknown)"}`,
    `- Major line: ${current.majorLine || "(unknown)"}`,
    "",
    "## Compatibility",
    "",
    `- Status: ${evaluation.status || "(unknown)"}`,
    `- Compatible: ${evaluation.compatible ? "yes" : "no"}`,
    evaluation.reasons?.length ? evaluation.reasons.map((reason) => `- ${reason}`).join("\n") : "- No breaking drift detected.",
    "",
    "## Suggested next action",
    "",
    evaluation.compatible
      ? "Review the Buildchain release notes, then update the consumer contract lock to the current SHA and contract digest."
      : "Failing before heavy build is intentional. Review the Buildchain contract change, update the consumer workflow/configuration, or pin the previous Buildchain SHA.",
  ].join("\n");
}
