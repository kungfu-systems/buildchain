import fs from "node:fs";
import path from "node:path";

export const STABLE_RELEASE_POLICY_CONTRACT = "kungfu-buildchain-stable-release-policy";
export const STABLE_RELEASE_GATE_CONTRACT = "kungfu-buildchain-stable-release-gate";

function string(value = "") {
  return String(value ?? "").trim();
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}

function timestamp(value, label) {
  const normalized = string(value);
  const milliseconds = Date.parse(normalized);
  if (!normalized || !Number.isFinite(milliseconds)) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function loadJsonInput({ cwd = process.cwd(), input = "", label }) {
  const normalized = string(input);
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("{")) {
    return JSON.parse(normalized);
  }
  const resolved = path.isAbsolute(normalized) ? normalized : path.resolve(cwd, normalized);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} path does not exist: ${normalized}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

export function loadStableReleasePolicy({ cwd = process.cwd(), input = "" } = {}) {
  const policy = loadJsonInput({ cwd, input, label: "stable release policy" });
  if (!policy) {
    return undefined;
  }
  if (policy.contract !== STABLE_RELEASE_POLICY_CONTRACT) {
    throw new Error(`stable release policy contract must be ${STABLE_RELEASE_POLICY_CONTRACT}`);
  }
  if (Number(policy.schemaVersion) !== 1) {
    throw new Error("stable release policy schemaVersion must be 1");
  }
  const minimumStableIntervalSeconds = positiveInteger(
    policy.minimumStableIntervalSeconds,
    "minimumStableIntervalSeconds",
  );
  const minimumCanarySoakSeconds = positiveInteger(
    policy.minimumCanarySoakSeconds,
    "minimumCanarySoakSeconds",
  );
  const productPathPrefixes = [...new Set(
    (Array.isArray(policy.productPathPrefixes) ? policy.productPathPrefixes : [])
      .map(string)
      .filter(Boolean),
  )];
  if (productPathPrefixes.length === 0) {
    throw new Error("stable release policy requires productPathPrefixes[]");
  }
  const requiredCanaries = (Array.isArray(policy.requiredCanaries) ? policy.requiredCanaries : [])
    .map((canary, index) => {
      const id = string(canary?.id);
      const source = string(canary?.source);
      if (!id) {
        throw new Error(`requiredCanaries[${index}].id is required`);
      }
      if (!new Set(["release-candidate", "commit-status"]).has(source)) {
        throw new Error(`requiredCanaries[${index}].source must be release-candidate or commit-status`);
      }
      if (source === "commit-status" && !string(canary.context)) {
        throw new Error(`requiredCanaries[${index}].context is required for commit-status canaries`);
      }
      return {
        id,
        source,
        repository: string(canary.repository),
        workflow: string(canary.workflow),
        context: string(canary.context),
        allowedAttestors: [...new Set(
          (Array.isArray(canary.allowedAttestors) ? canary.allowedAttestors : [])
            .map(string)
            .filter(Boolean),
        )],
      };
    });
  if (requiredCanaries.length === 0) {
    throw new Error("stable release policy requires requiredCanaries[]");
  }
  if (new Set(requiredCanaries.map((canary) => canary.id)).size !== requiredCanaries.length) {
    throw new Error("stable release policy canary ids must be unique");
  }
  return {
    schemaVersion: 1,
    contract: STABLE_RELEASE_POLICY_CONTRACT,
    enabled: policy.enabled !== false,
    minimumStableIntervalSeconds,
    minimumCanarySoakSeconds,
    productPathPrefixes,
    requiredCanaries,
  };
}

function check(ok, id, message, details = {}) {
  return { id, status: ok ? "pass" : "fail", message, details };
}

function matchesProductPath(file, prefixes) {
  return prefixes.some((prefix) => file === prefix || file.startsWith(prefix));
}

export function evaluateStableReleaseGate({
  policy,
  channel = "",
  candidate = {},
  previousStable = undefined,
  changedPaths = [],
  impact = {},
  canaries = [],
  now = new Date().toISOString(),
} = {}) {
  const normalizedChannel = string(channel);
  if (!policy || policy.enabled === false || normalizedChannel !== "release") {
    return {
      schemaVersion: 1,
      contract: STABLE_RELEASE_GATE_CONTRACT,
      applies: false,
      ok: true,
      channel: normalizedChannel,
      checks: [],
      summary: { reason: !policy ? "policy-not-configured" : policy.enabled === false ? "policy-disabled" : "non-stable-channel" },
    };
  }

  const nowTime = timestamp(now, "now");
  const candidatePublished = timestamp(candidate.publishedAt, "candidate.publishedAt");
  const candidateSha = string(candidate.sha);
  const candidateTag = string(candidate.tag);
  const checks = [];
  checks.push(check(/^[0-9a-f]{40}$/i.test(candidateSha), "candidate.sha", "candidate alpha SHA is exact", { sha: candidateSha }));
  checks.push(check(/-alpha\.\d+$/.test(candidateTag), "candidate.tag", "candidate is an exact alpha tag", { tag: candidateTag }));

  if (previousStable) {
    const previousPublished = timestamp(previousStable.publishedAt, "previousStable.publishedAt");
    const elapsedSeconds = Math.floor((nowTime.milliseconds - previousPublished.milliseconds) / 1000);
    checks.push(check(
      elapsedSeconds >= policy.minimumStableIntervalSeconds,
      "stable.minimum_interval",
      "minimum interval since the previous stable release is satisfied",
      {
        previousTag: string(previousStable.tag),
        previousPublishedAt: previousPublished.iso,
        elapsedSeconds,
        requiredSeconds: policy.minimumStableIntervalSeconds,
      },
    ));
  } else {
    checks.push(check(true, "stable.minimum_interval", "no previous stable release exists", { firstStable: true }));
  }

  const normalizedChangedPaths = [...new Set(changedPaths.map(string).filter(Boolean))].sort();
  const productChangedPaths = normalizedChangedPaths.filter((file) =>
    matchesProductPath(file, policy.productPathPrefixes));
  checks.push(check(
    productChangedPaths.length > 0,
    "stable.product_diff",
    "candidate contains a product or contract difference from the current stable release",
    { changedPaths: productChangedPaths, comparedPathCount: normalizedChangedPaths.length },
  ));

  const surfaceImpacts = Array.isArray(impact?.surfaceImpacts) ? impact.surfaceImpacts : [];
  checks.push(check(
    surfaceImpacts.length > 0 && string(impact?.summary) !== "",
    "stable.impact",
    "version-bound impact declares a summary and at least one surface",
    { summary: string(impact?.summary), surfaceIds: surfaceImpacts.map((entry) => string(entry?.id)).filter(Boolean) },
  ));

  const canaryById = new Map(canaries.map((canary) => [string(canary?.id), canary]));
  const canaryCompletionTimes = [];
  for (const required of policy.requiredCanaries) {
    const evidence = canaryById.get(required.id);
    const completedAt = evidence?.completedAt
      ? timestamp(evidence.completedAt, `canary ${required.id} completedAt`)
      : undefined;
    const attestorAllowed = required.allowedAttestors.length === 0 ||
      required.allowedAttestors.includes(string(evidence?.attestor));
    const valid = Boolean(
      evidence &&
      string(evidence.status) === "success" &&
      string(evidence.candidateSha) === candidateSha &&
      completedAt &&
      completedAt.milliseconds >= candidatePublished.milliseconds &&
      attestorAllowed,
    );
    if (completedAt) {
      canaryCompletionTimes.push(completedAt.milliseconds);
    }
    checks.push(check(
      valid,
      `stable.canary.${required.id}`,
      `required canary ${required.id} passed for the exact alpha candidate`,
      {
        source: required.source,
        context: required.context,
        repository: string(evidence?.repository || required.repository),
        workflow: string(evidence?.workflow || required.workflow),
        runtimeRef: string(evidence?.runtimeRef),
        runtimeRefSource: string(evidence?.runtimeRefSource),
        workflowId: string(evidence?.workflowId),
        candidateSha: string(evidence?.candidateSha),
        completedAt: completedAt?.iso || "",
        evidenceUrl: string(evidence?.evidenceUrl),
        attestor: string(evidence?.attestor),
        attestorAllowed,
      },
    ));
  }

  const soakStartMilliseconds = Math.max(candidatePublished.milliseconds, ...canaryCompletionTimes);
  const soakElapsedSeconds = Math.floor((nowTime.milliseconds - soakStartMilliseconds) / 1000);
  checks.push(check(
    canaryCompletionTimes.length === policy.requiredCanaries.length &&
      soakElapsedSeconds >= policy.minimumCanarySoakSeconds,
    "stable.canary_soak",
    "minimum soak interval after the final required canary is satisfied",
    {
      soakStartedAt: new Date(soakStartMilliseconds).toISOString(),
      elapsedSeconds: soakElapsedSeconds,
      requiredSeconds: policy.minimumCanarySoakSeconds,
    },
  ));

  const ok = checks.every((entry) => entry.status === "pass");
  return {
    schemaVersion: 1,
    contract: STABLE_RELEASE_GATE_CONTRACT,
    applies: true,
    ok,
    channel: normalizedChannel,
    evaluatedAt: nowTime.iso,
    candidate: {
      tag: candidateTag,
      sha: candidateSha,
      publishedAt: candidatePublished.iso,
    },
    previousStable: previousStable
      ? {
          tag: string(previousStable.tag),
          sha: string(previousStable.sha),
          publishedAt: timestamp(previousStable.publishedAt, "previousStable.publishedAt").iso,
        }
      : undefined,
    policy: {
      minimumStableIntervalSeconds: policy.minimumStableIntervalSeconds,
      minimumCanarySoakSeconds: policy.minimumCanarySoakSeconds,
      requiredCanaries: policy.requiredCanaries.map((canary) => canary.id),
    },
    checks,
    summary: {
      decision: ok ? "allow" : "block",
      failedChecks: checks.filter((entry) => entry.status === "fail").map((entry) => entry.id),
      productChangedPaths,
    },
  };
}

export function assertStableReleaseGate(input = {}) {
  const report = evaluateStableReleaseGate(input);
  if (!report.ok) {
    throw Object.assign(
      new Error(`stable release gate blocked promotion: ${report.summary.failedChecks.join(", ")}`),
      { report },
    );
  }
  return report;
}
