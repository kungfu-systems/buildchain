export const STABLE_CANDIDATE_LEDGER_CONTRACT = "kungfu-buildchain-stable-candidate-ledger";
export const STABLE_CANDIDATE_STATES = Object.freeze([
  "soaking",
  "qualified",
  "revoked",
  "promoted",
]);

function text(value = "") {
  return String(value ?? "").trim();
}

function iso(value, label) {
  const normalized = text(value);
  const milliseconds = Date.parse(normalized);
  if (!normalized || !Number.isFinite(milliseconds)) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function exactAlpha(version) {
  const normalized = text(version).replace(/^v/, "");
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)$/);
  if (!match) {
    throw new Error(`candidate version must be an exact alpha, got ${version || "<empty>"}`);
  }
  return {
    version: normalized,
    stableVersion: `${match[1]}.${match[2]}.${match[3]}`,
    order: match.slice(1).map(Number),
  };
}

function sha(value, label = "candidate sha") {
  const normalized = text(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be a 40-character commit SHA`);
  }
  return normalized;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareCandidates(left, right) {
  const a = exactAlpha(left.version).order;
  const b = exactAlpha(right.version).order;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return left.publishedAt.localeCompare(right.publishedAt);
}

export function createStableCandidateLedger({ repository, targetBranch, now = new Date().toISOString() } = {}) {
  const normalizedRepository = text(repository);
  const normalizedTargetBranch = text(targetBranch).replace(/^refs\/heads\//, "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalizedRepository)) {
    throw new Error(`repository must be owner/repo, got ${repository || "<empty>"}`);
  }
  if (!/^release\/v\d+\/v\d+\.\d+$/.test(normalizedTargetBranch)) {
    throw new Error(`targetBranch must be release/vN/vN.M, got ${targetBranch || "<empty>"}`);
  }
  return {
    schemaVersion: 1,
    contract: STABLE_CANDIDATE_LEDGER_CONTRACT,
    repository: normalizedRepository,
    targetBranch: normalizedTargetBranch,
    hold: { enabled: false, reason: "", updatedAt: iso(now, "now") },
    candidates: [],
    updatedAt: iso(now, "now"),
  };
}

export function normalizeStableCandidateLedger(input, expected = {}) {
  const ledger = clone(input || {});
  if (ledger.contract !== STABLE_CANDIDATE_LEDGER_CONTRACT || Number(ledger.schemaVersion) !== 1) {
    throw new Error(`stable candidate ledger must use ${STABLE_CANDIDATE_LEDGER_CONTRACT} schemaVersion 1`);
  }
  if (expected.repository && ledger.repository !== expected.repository) {
    throw new Error(`stable candidate ledger repository mismatch: ${ledger.repository} != ${expected.repository}`);
  }
  if (expected.targetBranch && ledger.targetBranch !== expected.targetBranch) {
    throw new Error(`stable candidate ledger targetBranch mismatch: ${ledger.targetBranch} != ${expected.targetBranch}`);
  }
  ledger.hold ||= { enabled: false, reason: "", updatedAt: ledger.updatedAt };
  ledger.candidates = (ledger.candidates || []).map((candidate) => {
    const parsed = exactAlpha(candidate.version);
    const state = text(candidate.state);
    if (!STABLE_CANDIDATE_STATES.includes(state)) {
      throw new Error(`unsupported candidate state ${state || "<empty>"}`);
    }
    return {
      ...candidate,
      version: parsed.version,
      stableVersion: parsed.stableVersion,
      sha: sha(candidate.sha),
      publishedAt: iso(candidate.publishedAt, `candidate ${parsed.version} publishedAt`),
      state,
    };
  });
  return ledger;
}

export function registerStableCandidate(ledgerInput, candidateInput, { now = new Date().toISOString() } = {}) {
  const ledger = normalizeStableCandidateLedger(ledgerInput);
  const parsed = exactAlpha(candidateInput.version);
  const candidateSha = sha(candidateInput.sha);
  const existing = ledger.candidates.find((candidate) => candidate.version === parsed.version);
  if (existing) {
    if (existing.sha !== candidateSha) {
      throw new Error(`candidate ${parsed.version} is already bound to ${existing.sha}, not ${candidateSha}`);
    }
    return ledger;
  }
  ledger.candidates.push({
    version: parsed.version,
    stableVersion: parsed.stableVersion,
    sha: candidateSha,
    tag: `v${parsed.version}`,
    publishedAt: iso(candidateInput.publishedAt, `candidate ${parsed.version} publishedAt`),
    state: "soaking",
    qualification: {
      ok: false,
      observedAt: "",
      soakStartedAt: "",
      soakElapsedSeconds: 0,
      requiredSeconds: 0,
      checks: [],
    },
    decision: { reason: "registered", updatedAt: iso(now, "now"), actor: text(candidateInput.actor) },
  });
  ledger.candidates.sort(compareCandidates);
  ledger.updatedAt = iso(now, "now");
  return ledger;
}

export function qualifyStableCandidate(
  ledgerInput,
  observation,
  { minimumSoakSeconds = 3600, now = new Date().toISOString() } = {},
) {
  const ledger = normalizeStableCandidateLedger(ledgerInput);
  const version = exactAlpha(observation.version).version;
  const candidate = ledger.candidates.find((entry) => entry.version === version);
  if (!candidate) throw new Error(`candidate ${version} is not registered`);
  if (candidate.sha !== sha(observation.sha)) {
    throw new Error(`candidate ${version} observation SHA does not match ledger`);
  }
  if (["revoked", "promoted"].includes(candidate.state)) return ledger;

  const checks = Array.isArray(observation.checks) ? observation.checks.map((check) => ({
    id: text(check.id),
    status: text(check.status),
    completedAt: check.completedAt ? iso(check.completedAt, `check ${check.id} completedAt`) : "",
    evidenceUrl: text(check.evidenceUrl),
  })) : [];
  const passed = checks.length > 0 && checks.every((check) => check.id && check.status === "pass" && check.completedAt);
  const latestCheck = passed ? Math.max(...checks.map((check) => Date.parse(check.completedAt))) : NaN;
  const soakStartedAt = passed
    ? new Date(Math.max(Date.parse(candidate.publishedAt), latestCheck)).toISOString()
    : "";
  const elapsedSeconds = passed
    ? Math.max(0, Math.floor((Date.parse(iso(now, "now")) - Date.parse(soakStartedAt)) / 1000))
    : 0;
  candidate.qualification = {
    ok: passed && elapsedSeconds >= Number(minimumSoakSeconds),
    observedAt: iso(now, "now"),
    soakStartedAt,
    soakElapsedSeconds: elapsedSeconds,
    requiredSeconds: Number(minimumSoakSeconds),
    checks,
  };
  candidate.state = candidate.qualification.ok ? "qualified" : "soaking";
  candidate.decision = {
    reason: candidate.qualification.ok ? "qualification-satisfied" : passed ? "soaking" : "checks-incomplete",
    updatedAt: iso(now, "now"),
    actor: text(observation.actor),
  };
  ledger.updatedAt = iso(now, "now");
  return ledger;
}

export function revokeStableCandidate(ledgerInput, versionInput, { reason, actor = "", now = new Date().toISOString() } = {}) {
  const ledger = normalizeStableCandidateLedger(ledgerInput);
  const version = exactAlpha(versionInput).version;
  const candidate = ledger.candidates.find((entry) => entry.version === version);
  if (!candidate) throw new Error(`candidate ${version} is not registered`);
  if (candidate.state === "promoted") throw new Error(`promoted candidate ${version} cannot be revoked`);
  if (!text(reason)) throw new Error("candidate revocation requires a reason");
  candidate.state = "revoked";
  candidate.decision = { reason: text(reason), actor: text(actor), updatedAt: iso(now, "now") };
  ledger.updatedAt = iso(now, "now");
  return ledger;
}

export function setStableCandidateHold(ledgerInput, enabled, { reason = "", now = new Date().toISOString() } = {}) {
  const ledger = normalizeStableCandidateLedger(ledgerInput);
  if (enabled && !text(reason)) throw new Error("enabling stable candidate hold requires a reason");
  ledger.hold = { enabled: Boolean(enabled), reason: text(reason), updatedAt: iso(now, "now") };
  ledger.updatedAt = iso(now, "now");
  return ledger;
}

export function selectStableCandidate(ledgerInput, { releaseNow = "", now = new Date().toISOString() } = {}) {
  const ledger = normalizeStableCandidateLedger(ledgerInput);
  if (ledger.hold.enabled && !releaseNow) {
    return { selected: false, reason: "repository-held", hold: ledger.hold };
  }
  if (releaseNow) {
    const version = exactAlpha(releaseNow).version;
    const candidate = ledger.candidates.find((entry) => entry.version === version);
    if (!candidate) return { selected: false, reason: "release-now-candidate-missing", version };
    if (["revoked", "promoted"].includes(candidate.state)) {
      return { selected: false, reason: `release-now-candidate-${candidate.state}`, candidate };
    }
    return { selected: true, reason: "human-release-now", authority: "human", candidate };
  }
  const candidates = ledger.candidates
    .filter((candidate) => candidate.state === "qualified")
    .sort(compareCandidates);
  const candidate = candidates.at(-1);
  return candidate
    ? { selected: true, reason: "latest-qualified", authority: "policy", candidate }
    : { selected: false, reason: "no-qualified-candidate" };
}

export function markStableCandidatePromoted(
  ledgerInput,
  versionInput,
  { stableTag = "", stableSha = "", now = new Date().toISOString() } = {},
) {
  const ledger = normalizeStableCandidateLedger(ledgerInput);
  const version = exactAlpha(versionInput).version;
  const candidate = ledger.candidates.find((entry) => entry.version === version);
  if (!candidate) throw new Error(`candidate ${version} is not registered`);
  const humanAuthority = candidate.decision?.reason === "human-release-now"
    || candidate.promotionRequest?.authority === "human";
  if (!candidate.qualification?.ok && !humanAuthority) {
    throw new Error(`candidate ${version} is not qualified for promotion`);
  }
  candidate.state = "promoted";
  candidate.promotion = {
    stableTag: text(stableTag) || `v${candidate.stableVersion}`,
    stableSha: stableSha ? sha(stableSha, "stable sha") : "",
    promotedAt: iso(now, "now"),
  };
  candidate.decision = { reason: "promoted", actor: "", updatedAt: iso(now, "now") };
  for (const entry of ledger.candidates) {
    if (entry.version !== version && entry.stableVersion === candidate.stableVersion && entry.state !== "promoted") {
      entry.state = "revoked";
      entry.decision = {
        reason: `stable-version-promoted-by:${version}`,
        actor: "buildchain",
        updatedAt: iso(now, "now"),
      };
    }
  }
  ledger.updatedAt = iso(now, "now");
  return ledger;
}

export function stableCandidatePromotionRefs(candidateInput, targetBranch) {
  const candidate = { ...candidateInput, ...exactAlpha(candidateInput.version) };
  const normalizedTarget = text(targetBranch).replace(/^refs\/heads\//, "");
  const match = normalizedTarget.match(/^release\/(v\d+)\/(v\d+\.\d+)$/);
  if (!match) throw new Error(`targetBranch must be release/vN/vN.M, got ${targetBranch || "<empty>"}`);
  if (`v${candidate.stableVersion.split(".").slice(0, 2).join(".")}` !== match[2]) {
    throw new Error(`candidate ${candidate.version} does not belong to ${normalizedTarget}`);
  }
  return {
    sourceRef: `publish-gate/release/${match[1]}/${match[2]}/${candidate.version}`,
    targetRef: normalizedTarget,
    exactAlphaTag: `v${candidate.version}`,
    stableTag: `v${candidate.stableVersion}`,
  };
}
