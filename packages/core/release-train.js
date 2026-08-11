// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

export const RELEASE_CUT_CONTRACT = "kungfu-buildchain-release-cut/v1";
export const RELEASE_TRAIN_CONTRACT = "kungfu-buildchain-release-train/v1";
export const RELEASE_TRAIN_TRANSITION_CONTRACT =
  "kungfu-buildchain-release-train-transition/v1";
export const RELEASE_TRAIN_OBSERVATION_CONTRACT =
  "kungfu-buildchain-release-train-observation/v1";
export const RELEASE_BLOCKER_REPAIR_CONTRACT =
  "kungfu-buildchain-release-blocker-repair/v1";
export const LEGACY_DEV_ALPHA_CANDIDATE_STATE_SCHEMA =
  "kungfu-buildchain-dev-alpha-candidate-state/v1";

export const RELEASE_TRAIN_STATES = Object.freeze([
  "preparing",
  "building",
  "repair-required",
  "publication-blocked",
  "publishable",
  "superseded",
  "terminal",
]);

export const RELEASE_TRAIN_SUPERSESSION_CAUSES = Object.freeze([
  "release-blocker-repair",
  "incompatible-semantics",
  "alpha-base-incompatibility",
  "invalid-authority",
  "severe-security",
]);

const SHA = /^[0-9a-f]{40}$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const ABSENT_ROOT = `sha256:${"0".repeat(64)}`;
const SUPERSESSION_CAUSES = new Set(RELEASE_TRAIN_SUPERSESSION_CAUSES);
const TRANSITIONS = new Map([
  ["preparing", new Set(["building", "repair-required", "superseded"])],
  [
    "building",
    new Set([
      "repair-required",
      "publication-blocked",
      "publishable",
      "superseded",
    ]),
  ],
  [
    "repair-required",
    new Set(["building", "publication-blocked", "superseded"]),
  ],
  [
    "publication-blocked",
    new Set(["repair-required", "publishable", "superseded"]),
  ],
  ["publishable", new Set(["terminal", "repair-required", "superseded"])],
  ["superseded", new Set()],
  ["terminal", new Set()],
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function releaseTrainRoot(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

function clone(value) {
  return structuredClone(value);
}

function text(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function exactSha(value, label) {
  const normalized = text(value, label).toLowerCase();
  if (!SHA.test(normalized))
    throw new Error(`${label} must be an exact 40-character Git SHA`);
  return normalized;
}

function contentRoot(value, label) {
  const normalized = text(value, label).toLowerCase();
  if (!ROOT.test(normalized))
    throw new Error(`${label} must be a sha256 content root`);
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1)
    throw new Error(`${label} must be a positive integer`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = text(value, label);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds))
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  const canonicalTimestamp = new Date(milliseconds).toISOString();
  if (normalized !== canonicalTimestamp)
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  return normalized;
}

function repository(value) {
  const normalized = text(value, "repository");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(normalized))
    throw new Error("repository must be owner/repo");
  return normalized;
}

function branch(value, label) {
  const normalized = text(value, label).replace(/^refs\/heads\//u, "");
  if (/\s/u.test(normalized))
    throw new Error(`${label} must not contain spaces`);
  return normalized;
}

function sortedRoots(values, label) {
  if (!Array.isArray(values) || values.length === 0)
    throw new Error(`${label} must be a non-empty array`);
  const normalized = values.map((value, index) =>
    contentRoot(value, `${label}[${index}]`),
  );
  const expected = [...new Set(normalized)].sort();
  if (
    normalized.length !== expected.length ||
    normalized.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${label} must be sorted and duplicate-free`);
  }
  return normalized;
}

function assertExactFields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new Error(`${label} has an invalid field set`);
  }
}

function normalizeSupersession(value, generation) {
  if (generation === 1) {
    if (value !== null && value !== undefined)
      throw new Error("generation 1 cannot supersede a prior Release Cut");
    return null;
  }
  assertExactFields(value, ["cause", "priorCutRoot"], "supersession");
  const cause = text(value.cause, "supersession.cause");
  if (!SUPERSESSION_CAUSES.has(cause))
    throw new Error(`unsupported Release Cut supersession cause: ${cause}`);
  return {
    cause,
    priorCutRoot: contentRoot(value.priorCutRoot, "supersession.priorCutRoot"),
  };
}

export function createReleaseCut(input = {}) {
  const generation = positiveInteger(input.generation ?? 1, "generation");
  const body = {
    schemaVersion: 1,
    contract: RELEASE_CUT_CONTRACT,
    repository: repository(input.repository),
    sourceBranch: branch(input.sourceBranch, "sourceBranch"),
    targetBranch: branch(input.targetBranch, "targetBranch"),
    originDevSha: exactSha(input.originDevSha, "originDevSha"),
    candidateSha: exactSha(input.candidateSha, "candidateSha"),
    candidateTreeSha: exactSha(input.candidateTreeSha, "candidateTreeSha"),
    alphaBaseSha: exactSha(input.alphaBaseSha, "alphaBaseSha"),
    buildchainRuntimeSha: exactSha(
      input.buildchainRuntimeSha,
      "buildchainRuntimeSha",
    ),
    generation,
    authorityRoots: sortedRoots(input.authorityRoots, "authorityRoots"),
    supersession: normalizeSupersession(input.supersession, generation),
    createdAt: timestamp(input.createdAt, "createdAt"),
  };
  return { ...body, cutRoot: releaseTrainRoot(body) };
}

function initialState(releaseCut) {
  const body = {
    status: "preparing",
    generation: releaseCut.generation,
    priorStateRoot: ABSENT_ROOT,
    transitionRoot: ABSENT_ROOT,
  };
  return { ...body, stateRoot: releaseTrainRoot(body) };
}

export function createReleaseTrain(input = {}) {
  const releaseCut = createReleaseCut(input.releaseCut || input);
  const identity = {
    schemaVersion: 1,
    contract: RELEASE_TRAIN_CONTRACT,
    releaseCut,
  };
  return {
    ...identity,
    trainRoot: releaseTrainRoot(identity),
    state: initialState(releaseCut),
    transitions: [],
    observations: [],
  };
}

export function validateReleaseCut(cut) {
  assertExactFields(
    cut,
    [
      "schemaVersion",
      "contract",
      "repository",
      "sourceBranch",
      "targetBranch",
      "originDevSha",
      "candidateSha",
      "candidateTreeSha",
      "alphaBaseSha",
      "buildchainRuntimeSha",
      "generation",
      "authorityRoots",
      "supersession",
      "createdAt",
      "cutRoot",
    ],
    "Release Cut",
  );
  const normalized = createReleaseCut(cut);
  if (cut.cutRoot !== normalized.cutRoot)
    throw new Error("Release Cut root does not match its content");
  return normalized;
}

function transitionRequest(input, train) {
  const to = text(input.to, "transition.to");
  if (!RELEASE_TRAIN_STATES.includes(to))
    throw new Error(`unsupported Release Train state: ${to}`);
  const expectedStateRoot = contentRoot(
    input.expectedStateRoot,
    "transition.expectedStateRoot",
  );
  const superseding = to === "superseded";
  const cause = input.supersessionCause
    ? text(input.supersessionCause, "transition.supersessionCause")
    : "";
  if (superseding && !SUPERSESSION_CAUSES.has(cause))
    throw new Error("superseded transitions require an enumerated cause");
  if (
    !superseding &&
    (cause || input.replacementCutRoot || input.replacementCandidateSha)
  )
    throw new Error(
      "supersession fields are only valid for superseded transitions",
    );
  return {
    contract: RELEASE_TRAIN_TRANSITION_CONTRACT,
    trainRoot: train.trainRoot,
    expectedStateRoot,
    to,
    event: text(input.event, "transition.event"),
    reason: text(input.reason, "transition.reason"),
    authorityRoots: sortedRoots(
      input.authorityRoots,
      "transition.authorityRoots",
    ),
    ...(superseding
      ? {
          supersessionCause: cause,
          replacementCutRoot: contentRoot(
            input.replacementCutRoot,
            "transition.replacementCutRoot",
          ),
          replacementCandidateSha: exactSha(
            input.replacementCandidateSha,
            "transition.replacementCandidateSha",
          ),
        }
      : {}),
    recordedAt: timestamp(input.recordedAt, "transition.recordedAt"),
  };
}

function applyTransition(train, input) {
  const request = transitionRequest(input, train);
  const requestRoot = releaseTrainRoot(request);
  const last = train.transitions.at(-1);
  if (last?.requestRoot === requestRoot) return train;
  if (request.expectedStateRoot !== train.state.stateRoot)
    throw new Error("Release Train transition compare-and-swap failed");
  if (!TRANSITIONS.get(train.state.status)?.has(request.to))
    throw new Error(
      `invalid Release Train transition: ${train.state.status} -> ${request.to}`,
    );
  const transition = {
    ...request,
    from: train.state.status,
    requestRoot,
  };
  transition.transitionRoot = releaseTrainRoot(transition);
  const stateBody = {
    status: request.to,
    generation: train.releaseCut.generation,
    priorStateRoot: train.state.stateRoot,
    transitionRoot: transition.transitionRoot,
  };
  return {
    ...train,
    state: { ...stateBody, stateRoot: releaseTrainRoot(stateBody) },
    transitions: [...train.transitions, transition],
  };
}

export function transitionReleaseTrain(trainInput, input = {}) {
  return applyTransition(validateReleaseTrain(trainInput), input);
}

function applyObservation(train, input) {
  const body = {
    contract: RELEASE_TRAIN_OBSERVATION_CONTRACT,
    trainRoot: train.trainRoot,
    observedDevSha: exactSha(input.observedDevSha, "observedDevSha"),
    observedAt: timestamp(input.observedAt, "observedAt"),
  };
  const observation = { ...body, observationRoot: releaseTrainRoot(body) };
  if (
    train.observations.some(
      (entry) => entry.observationRoot === observation.observationRoot,
    )
  ) {
    return train;
  }
  return { ...train, observations: [...train.observations, observation] };
}

export function observeReleaseTrain(trainInput, input = {}) {
  return applyObservation(validateReleaseTrain(trainInput), input);
}

export function validateReleaseTrain(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Release Train must be an object");
  if (
    input.contract !== RELEASE_TRAIN_CONTRACT ||
    Number(input.schemaVersion) !== 1
  ) {
    throw new Error(`Release Train must use ${RELEASE_TRAIN_CONTRACT}`);
  }
  assertExactFields(
    input,
    [
      "schemaVersion",
      "contract",
      "releaseCut",
      "trainRoot",
      "state",
      "transitions",
      "observations",
    ],
    "Release Train",
  );
  const releaseCut = validateReleaseCut(input.releaseCut);
  const identity = {
    schemaVersion: 1,
    contract: RELEASE_TRAIN_CONTRACT,
    releaseCut,
  };
  if (input.trainRoot !== releaseTrainRoot(identity))
    throw new Error("Release Train root does not match its frozen Release Cut");
  if (!RELEASE_TRAIN_STATES.includes(input.state?.status))
    throw new Error("Release Train state is invalid");
  assertExactFields(
    input.state,
    ["status", "generation", "priorStateRoot", "transitionRoot", "stateRoot"],
    "Release Train state",
  );
  if (input.state.generation !== releaseCut.generation)
    throw new Error(
      "Release Train state generation drifted from its Release Cut",
    );
  const stateBody = {
    status: input.state.status,
    generation: input.state.generation,
    priorStateRoot: contentRoot(
      input.state.priorStateRoot,
      "state.priorStateRoot",
    ),
    transitionRoot: contentRoot(
      input.state.transitionRoot,
      "state.transitionRoot",
    ),
  };
  if (input.state.stateRoot !== releaseTrainRoot(stateBody))
    throw new Error("Release Train state root does not match its content");
  if (!Array.isArray(input.transitions) || !Array.isArray(input.observations))
    throw new Error(
      "Release Train transitions and observations must be arrays",
    );
  const replay = createReleaseTrain({ releaseCut });
  let rebuilt = replay;
  for (const [index, transition] of input.transitions.entries()) {
    assertExactFields(
      transition,
      [
        "contract",
        "trainRoot",
        "expectedStateRoot",
        "to",
        "event",
        "reason",
        "authorityRoots",
        ...(transition.to === "superseded"
          ? [
              "supersessionCause",
              "replacementCutRoot",
              "replacementCandidateSha",
            ]
          : []),
        "recordedAt",
        "from",
        "requestRoot",
        "transitionRoot",
      ],
      `Release Train transition ${index}`,
    );
    rebuilt = applyTransition(rebuilt, transition);
    const replayed = rebuilt.transitions.at(-1);
    if (
      rebuilt.transitions.length !== index + 1 ||
      releaseTrainRoot(replayed) !== releaseTrainRoot(transition)
    ) {
      throw new Error(
        "Release Train transition root does not match its content",
      );
    }
  }
  if (rebuilt.state.stateRoot !== input.state.stateRoot)
    throw new Error(
      "Release Train state chain does not replay to the current state",
    );
  for (const [index, observation] of input.observations.entries()) {
    assertExactFields(
      observation,
      [
        "contract",
        "trainRoot",
        "observedDevSha",
        "observedAt",
        "observationRoot",
      ],
      `Release Train observation ${index}`,
    );
    rebuilt = applyObservation(rebuilt, observation);
    const replayed = rebuilt.observations.at(-1);
    if (
      rebuilt.observations.length !== index + 1 ||
      releaseTrainRoot(replayed) !== releaseTrainRoot(observation)
    ) {
      throw new Error(
        "Release Train observation root does not match its content",
      );
    }
  }
  if (rebuilt.observations.length !== input.observations.length)
    throw new Error("Release Train observations must be unique");
  return clone(input);
}

export function readReleaseTrain(input) {
  if (input?.contract === RELEASE_TRAIN_CONTRACT) {
    return {
      format: "release-train-v1",
      authoritative: true,
      train: validateReleaseTrain(input),
    };
  }
  if (input?.schema === LEGACY_DEV_ALPHA_CANDIDATE_STATE_SCHEMA) {
    const generation = positiveInteger(input.generation, "legacy generation");
    const candidate = input.activeCandidate || input.nextCandidate;
    return {
      format: "legacy-dev-alpha-candidate-state-v1",
      authoritative: false,
      train: null,
      legacy: {
        generation,
        candidateSha: candidate
          ? exactSha(candidate.sourceSha, "legacy candidate sourceSha")
          : "",
        stateRoot: ROOT.test(String(input.stateRoot || ""))
          ? String(input.stateRoot)
          : "",
      },
      reason:
        "legacy candidate state can be read but cannot manufacture Release Cut authority roots",
    };
  }
  throw new Error("unsupported Release Train record");
}

function releaseBlockerLanding(input, label, { allowConflict = false } = {}) {
  const status = text(input?.status, `${label}.status`);
  if (status !== "landed" && !(allowConflict && status === "conflict")) {
    throw new Error(
      `${label}.status must be ${allowConflict ? "landed or conflict" : "landed"}`,
    );
  }
  const landing = {
    status,
    baseSha: exactSha(input.baseSha, `${label}.baseSha`),
    landedSha:
      status === "landed"
        ? exactSha(input.landedSha, `${label}.landedSha`)
        : "",
    patchRoot: contentRoot(input.patchRoot, `${label}.patchRoot`),
    evidenceRoot: contentRoot(input.evidenceRoot, `${label}.evidenceRoot`),
  };
  return landing;
}

function releaseBlockerPublication(patchRoot, devLanding) {
  const eligible =
    devLanding.status === "landed" && devLanding.patchRoot === patchRoot;
  const body = {
    eligible,
    reason:
      devLanding.status === "conflict"
        ? "dev-forward-port-conflict"
        : eligible
          ? "exact-cut-dev-patch-settled"
          : "cut-dev-patch-root-mismatch",
    requiredPatchRoot: patchRoot,
    observedDevPatchRoot: devLanding.patchRoot,
    devLandingStatus: devLanding.status,
  };
  return { ...body, gateRoot: releaseTrainRoot(body) };
}

function buildReleaseBlockerRepair(activeTrainInput, input = {}) {
  const activeTrain = validateReleaseTrain(activeTrainInput);
  if (activeTrain.state.status !== "repair-required") {
    throw new Error(
      "release-blocker repair requires the active train to be repair-required",
    );
  }
  const expectedStateRoot = contentRoot(
    input.expectedStateRoot,
    "expectedStateRoot",
  );
  if (expectedStateRoot !== activeTrain.state.stateRoot) {
    throw new Error("release-blocker repair compare-and-swap failed");
  }
  const patchRoot = contentRoot(input.patchRoot, "patchRoot");
  const blockerRoot = contentRoot(input.blockerRoot, "blockerRoot");
  const authorityRoots = sortedRoots(input.authorityRoots, "authorityRoots");
  const createdAt = timestamp(input.createdAt, "createdAt");
  const cutLanding = releaseBlockerLanding(
    {
      status: "landed",
      baseSha: activeTrain.releaseCut.candidateSha,
      landedSha: input.cutCandidateSha,
      patchRoot: input.cutPatchRoot,
      evidenceRoot: input.cutLandingEvidenceRoot,
    },
    "cutLanding",
  );
  if (cutLanding.patchRoot !== patchRoot) {
    throw new Error(
      "cut landing must preserve the declared release-blocker patch root",
    );
  }
  const devLanding = releaseBlockerLanding(
    {
      status: input.devLandingStatus,
      baseSha: input.devBaseSha,
      landedSha: input.devLandingSha,
      patchRoot: input.devPatchRoot,
      evidenceRoot: input.devLandingEvidenceRoot,
    },
    "devLanding",
    { allowConflict: true },
  );
  const priorCut = activeTrain.releaseCut;
  const successorTrain = createReleaseTrain({
    repository: priorCut.repository,
    sourceBranch: priorCut.sourceBranch,
    targetBranch: priorCut.targetBranch,
    originDevSha: priorCut.originDevSha,
    candidateSha: cutLanding.landedSha,
    candidateTreeSha: exactSha(
      input.cutCandidateTreeSha,
      "cutCandidateTreeSha",
    ),
    alphaBaseSha: priorCut.alphaBaseSha,
    buildchainRuntimeSha: priorCut.buildchainRuntimeSha,
    generation: priorCut.generation + 1,
    authorityRoots: [
      ...new Set([...priorCut.authorityRoots, ...authorityRoots]),
    ].sort(),
    supersession: {
      cause: "release-blocker-repair",
      priorCutRoot: priorCut.cutRoot,
    },
    createdAt,
  });
  const supersededTrain = transitionReleaseTrain(activeTrain, {
    to: "superseded",
    expectedStateRoot,
    event: "release-blocker-successor-cut",
    reason:
      "a rooted release-blocker repair advanced the active candidate generation",
    authorityRoots,
    supersessionCause: "release-blocker-repair",
    replacementCutRoot: successorTrain.releaseCut.cutRoot,
    replacementCandidateSha: successorTrain.releaseCut.candidateSha,
    recordedAt: createdAt,
  });
  const publication = releaseBlockerPublication(patchRoot, devLanding);
  const body = {
    schemaVersion: 1,
    contract: RELEASE_BLOCKER_REPAIR_CONTRACT,
    blockerRoot,
    patchRoot,
    priorTrain: activeTrain,
    supersededTrain,
    successorTrain,
    cutLanding,
    devLanding,
    candidateBuild: {
      eligible: true,
      candidateSha: successorTrain.releaseCut.candidateSha,
      candidateTreeSha: successorTrain.releaseCut.candidateTreeSha,
      generation: successorTrain.releaseCut.generation,
      cutRoot: successorTrain.releaseCut.cutRoot,
      reason: "rooted-cut-landing",
    },
    publication,
    authorityRoots,
    createdAt,
  };
  return { ...body, repairRoot: releaseTrainRoot(body) };
}

export function createReleaseBlockerRepair(activeTrainInput, input = {}) {
  return buildReleaseBlockerRepair(activeTrainInput, input);
}

export function validateReleaseBlockerRepair(input) {
  if (
    input?.contract !== RELEASE_BLOCKER_REPAIR_CONTRACT ||
    Number(input?.schemaVersion) !== 1
  ) {
    throw new Error(
      `release-blocker repair must use ${RELEASE_BLOCKER_REPAIR_CONTRACT}`,
    );
  }
  const rebuilt = buildReleaseBlockerRepair(input.priorTrain, {
    expectedStateRoot: input.priorTrain?.state?.stateRoot,
    blockerRoot: input.blockerRoot,
    patchRoot: input.patchRoot,
    cutCandidateSha: input.cutLanding?.landedSha,
    cutCandidateTreeSha: input.successorTrain?.releaseCut?.candidateTreeSha,
    cutPatchRoot: input.cutLanding?.patchRoot,
    cutLandingEvidenceRoot: input.cutLanding?.evidenceRoot,
    devLandingStatus: input.devLanding?.status,
    devBaseSha: input.devLanding?.baseSha,
    devLandingSha: input.devLanding?.landedSha,
    devPatchRoot: input.devLanding?.patchRoot,
    devLandingEvidenceRoot: input.devLanding?.evidenceRoot,
    authorityRoots: input.authorityRoots,
    createdAt: input.createdAt,
  });
  if (input.repairRoot !== rebuilt.repairRoot) {
    throw new Error("release-blocker repair root does not match its content");
  }
  if (releaseTrainRoot(input) !== releaseTrainRoot(rebuilt)) {
    throw new Error(
      "release-blocker repair content drifted from its rooted contract",
    );
  }
  return clone(input);
}

export function settleReleaseBlockerDevLanding(repairInput, input = {}) {
  const repair = validateReleaseBlockerRepair(repairInput);
  if (
    contentRoot(input.expectedRepairRoot, "expectedRepairRoot") !==
    repair.repairRoot
  ) {
    throw new Error(
      "release-blocker repair settlement compare-and-swap failed",
    );
  }
  const patchRoot = contentRoot(input.patchRoot, "patchRoot");
  if (patchRoot !== repair.patchRoot) {
    throw new Error(
      "dev landing settlement must preserve the release-blocker patch root",
    );
  }
  return buildReleaseBlockerRepair(repair.priorTrain, {
    expectedStateRoot: repair.priorTrain.state.stateRoot,
    blockerRoot: repair.blockerRoot,
    patchRoot: repair.patchRoot,
    cutCandidateSha: repair.cutLanding.landedSha,
    cutCandidateTreeSha: repair.successorTrain.releaseCut.candidateTreeSha,
    cutPatchRoot: repair.cutLanding.patchRoot,
    cutLandingEvidenceRoot: repair.cutLanding.evidenceRoot,
    devLandingStatus: "landed",
    devBaseSha: input.devBaseSha,
    devLandingSha: input.devLandingSha,
    devPatchRoot: patchRoot,
    devLandingEvidenceRoot: input.devLandingEvidenceRoot,
    authorityRoots: repair.authorityRoots,
    createdAt: repair.createdAt,
  });
}
