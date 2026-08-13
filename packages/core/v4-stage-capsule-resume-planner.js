import {
  V4ContractFault,
  v4ContentRoot,
  validateV4Clock,
  validateV4Root,
} from "./v4-canonical-contracts.js";
import {
  V4_STAGE_CAPSULE_REUSE_CONTRACT,
  evaluateV4StageCapsuleReuse,
  v4StageCapsuleAvailabilityRoot,
  validateV4StageCapsule,
  validateV4StageCapsuleAvailability,
  validateV4StageCapsuleIdentity,
} from "./v4-stage-capsule.js";

export const V4_STAGE_CAPSULE_RESUME_REQUEST_CONTRACT =
  "buildchain-v4-stage-capsule-resume-request/v1";
export const V4_STAGE_CAPSULE_RESUME_PLAN_CONTRACT =
  "buildchain-v4-stage-capsule-resume-plan/v1";

const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function fault(code, path, message) {
  throw new V4ContractFault(code, path, message);
}

function exactKeys(value, expected, location) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault("invalid-stage-capsule-resume-shape", location, "object required");
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  )
    fault(
      "invalid-stage-capsule-resume-shape",
      location,
      "keys do not match the closed resume contract",
    );
}

function token(value, location) {
  if (typeof value !== "string" || !TOKEN.test(value))
    fault(
      "invalid-stage-capsule-resume-token",
      location,
      "resume planner identifiers must be ASCII tokens",
    );
}

function orderedTokens(values, location) {
  if (!Array.isArray(values))
    fault("invalid-stage-capsule-resume-shape", location, "array required");
  let prior = null;
  for (const [index, value] of values.entries()) {
    token(value, `${location}/${index}`);
    if (prior !== null && value <= prior)
      fault(
        "unordered-stage-capsule-resume-values",
        `${location}/${index}`,
        "resume planner values must be unique and byte-sorted",
      );
    prior = value;
  }
}

function validateRetentionPromise(value, location) {
  exactKeys(value, ["class", "retainUntil"], location);
  token(value.class, `${location}/class`);
  validateV4Clock(value.retainUntil, `${location}/retainUntil`);
}

function observationRoot(value) {
  return v4ContentRoot("stage-capsule-resume-observation", value);
}

function rootOrObservationRoot(value) {
  try {
    validateV4Root(value, "$/resumeObservation");
    return value;
  } catch {
    return observationRoot(value);
  }
}

function cause(field, expected, observed, rooted = false) {
  return {
    field,
    expectedRoot: rooted
      ? rootOrObservationRoot(expected)
      : observationRoot(expected),
    observedRoot: rooted
      ? rootOrObservationRoot(observed)
      : observationRoot(observed),
  };
}

function validateRequest(request) {
  exactKeys(
    request,
    ["schema", "evaluatedAt", "nodes", "targets", "effects"],
    "$",
  );
  if (
    request.schema !== V4_STAGE_CAPSULE_RESUME_REQUEST_CONTRACT ||
    !Array.isArray(request.nodes) ||
    request.nodes.length === 0
  )
    fault(
      "unsupported-stage-capsule-resume-version",
      "$/schema",
      "unsupported or empty Stage Capsule resume request",
    );
  validateV4Clock(request.evaluatedAt, "$/evaluatedAt");
  const positions = new Map();
  for (const [index, node] of request.nodes.entries()) {
    const location = `$/nodes/${index}`;
    exactKeys(
      node,
      [
        "key",
        "dependencies",
        "expectedIdentity",
        "expectedRetentionPromise",
        "candidate",
      ],
      location,
    );
    token(node.key, `${location}/key`);
    if (positions.has(node.key))
      fault(
        "invalid-stage-capsule-resume-node",
        `${location}/key`,
        "resume node keys must be unique",
      );
    positions.set(node.key, index);
    orderedTokens(node.dependencies, `${location}/dependencies`);
    if (
      node.dependencies.some(
        (dependency) =>
          !positions.has(dependency) || positions.get(dependency) >= index,
      )
    )
      fault(
        "invalid-stage-capsule-resume-dependency",
        `${location}/dependencies`,
        "dependencies must name an earlier node in topological order",
      );
    validateV4StageCapsuleIdentity(node.expectedIdentity);
    validateRetentionPromise(
      node.expectedRetentionPromise,
      `${location}/expectedRetentionPromise`,
    );
    if (node.candidate !== null) {
      exactKeys(
        node.candidate,
        ["capsule", "availability"],
        `${location}/candidate`,
      );
      validateV4StageCapsule(node.candidate.capsule);
      validateV4StageCapsuleAvailability(node.candidate.availability);
    }
  }
  orderedTokens(request.targets, "$/targets");
  if (
    request.targets.length === 0 ||
    request.targets.some((target) => !positions.has(target))
  )
    fault(
      "invalid-stage-capsule-resume-target",
      "$/targets",
      "targets must name at least one declared node",
    );
  if (!Array.isArray(request.effects))
    fault("invalid-stage-capsule-resume-shape", "$/effects", "array required");
  let priorEffect = null;
  for (const [index, effect] of request.effects.entries()) {
    const location = `$/effects/${index}`;
    exactKeys(
      effect,
      ["id", "kind", "provider", "afterStages", "providerReadback", "mutation"],
      location,
    );
    token(effect.id, `${location}/id`);
    token(effect.kind, `${location}/kind`);
    token(effect.provider, `${location}/provider`);
    orderedTokens(effect.afterStages, `${location}/afterStages`);
    if (
      (priorEffect !== null && effect.id <= priorEffect) ||
      effect.providerReadback !== true ||
      effect.mutation !== false ||
      effect.afterStages.some((stage) => !positions.has(stage))
    )
      fault(
        "invalid-stage-capsule-resume-effect",
        location,
        "effects must be sorted, readback-required, mutation-disabled declarations",
      );
    priorEffect = effect.id;
  }
  return positions;
}

function decision(node, kind, reasonCode, details = {}) {
  return {
    stageKey: node.key,
    platform: node.expectedIdentity.platform,
    stage: node.expectedIdentity.stage,
    decision: kind,
    execution: kind === "reuse" ? "reuse" : "rebuild",
    reasonCode,
    capsuleRoot: details.capsuleRoot ?? null,
    availabilityRoot: details.availabilityRoot ?? null,
    invalidationCauses: details.invalidationCauses ?? [],
    requiredReads: details.requiredReads ?? [],
  };
}

function changedDecision(node, candidate, availabilityRoot) {
  const expected = node.expectedIdentity;
  const observed = candidate.capsule.identity;
  const details = (entry) => ({
    capsuleRoot: candidate.capsule.capsuleRoot,
    availabilityRoot,
    invalidationCauses: [entry],
  });
  const fields = [
    ["platform", "platform", "reject", "cross-platform", false],
    ["stage", "stage", "reject", "stage-mismatch", false],
    ["sourceRoot", "source-root", "rebuild", "source-changed", true],
    ["platformRoot", "platform-root", "rebuild", "platform-changed", true],
    [
      "toolchainRoots",
      "toolchain-roots",
      "rebuild",
      "toolchain-changed",
      false,
    ],
    ["runtimeRoot", "runtime-root", "rebuild", "runtime-changed", true],
    ["policyRoot", "policy-root", "rebuild", "policy-changed", true],
    ["declaredInputs", "declared-inputs", "rebuild", "input-changed", false],
    [
      "transformationRoot",
      "transformation-root",
      "rebuild",
      "transformation-changed",
      true,
    ],
    [
      "outputManifestRoot",
      "output-manifest-root",
      "rebuild",
      "output-manifest-changed",
      true,
    ],
    [
      "qualificationRoot",
      "qualification-root",
      "reject",
      "evidence-insufficient",
      true,
    ],
    [
      "observationRoots",
      "observation-roots",
      "reject",
      "evidence-insufficient",
      false,
    ],
  ];
  for (const [field, causeField, kind, reason, rooted] of fields)
    if (JSON.stringify(expected[field]) !== JSON.stringify(observed[field]))
      return decision(
        node,
        kind,
        reason,
        details(cause(causeField, expected[field], observed[field], rooted)),
      );
  if (
    JSON.stringify(node.expectedRetentionPromise) !==
    JSON.stringify(candidate.capsule.retentionPromise)
  )
    return decision(
      node,
      "rebuild",
      "retention-changed",
      details(
        cause(
          "retention-promise",
          node.expectedRetentionPromise,
          candidate.capsule.retentionPromise,
        ),
      ),
    );
  return null;
}

function candidateDecision(node, evaluatedAt) {
  if (node.candidate === null) return decision(node, "rebuild", "unavailable");
  const { capsule, availability } = node.candidate;
  const availabilityRoot = v4StageCapsuleAvailabilityRoot(availability);
  const changed = changedDecision(node, node.candidate, availabilityRoot);
  if (changed) return changed;
  const reuse = evaluateV4StageCapsuleReuse({
    schema: V4_STAGE_CAPSULE_REUSE_CONTRACT,
    capsule,
    availability,
    evaluatedAt,
    expectedCapsuleRoot: capsule.capsuleRoot,
    expectedOutputManifestRoot: node.expectedIdentity.outputManifestRoot,
    expectedQualificationRoot: node.expectedIdentity.qualificationRoot,
  });
  if (reuse.eligible) {
    const requiredReads = [
      { kind: "availability", name: node.key, root: availabilityRoot },
      { kind: "capsule", name: node.key, root: capsule.capsuleRoot },
      {
        kind: "manifest",
        name: node.key,
        root: node.expectedIdentity.outputManifestRoot,
      },
      {
        kind: "qualification",
        name: node.key,
        root: node.expectedIdentity.qualificationRoot,
      },
      ...availability.transports.map(({ name, root }) => ({
        kind: "transport",
        name,
        root,
      })),
    ];
    return decision(node, "reuse", "eligible", {
      capsuleRoot: capsule.capsuleRoot,
      availabilityRoot,
      requiredReads,
    });
  }
  const mapping = {
    missing: ["rebuild", "unavailable"],
    expired: ["rebuild", "expired"],
    partial: ["reject", "partial"],
    corrupt: ["reject", "corrupt"],
    quarantined: ["reject", "quarantined"],
    "root-mismatch": ["reject", "root-mismatch"],
  };
  const [kind, reason] = mapping[reuse.reason] ?? [
    "reject",
    "evidence-insufficient",
  ];
  return decision(node, kind, reason, {
    capsuleRoot: capsule.capsuleRoot,
    availabilityRoot,
  });
}

export function planV4StageCapsuleResume(request) {
  const positions = validateRequest(request);
  const decisions = request.nodes.map((node) =>
    candidateDecision(node, request.evaluatedAt),
  );
  const needed = new Set();
  const mark = (index) => {
    if (needed.has(index)) return;
    needed.add(index);
    if (decisions[index].execution === "reuse") return;
    for (const dependency of request.nodes[index].dependencies)
      mark(positions.get(dependency));
  };
  for (const target of request.targets) mark(positions.get(target));
  const requiredRestores = request.nodes
    .filter(
      (_, index) => needed.has(index) && decisions[index].execution === "reuse",
    )
    .map(({ key }) => key);
  const requiredStages = request.nodes
    .filter(
      (_, index) =>
        needed.has(index) && decisions[index].execution === "rebuild",
    )
    .map(({ key }) => key);
  const payload = {
    schema: V4_STAGE_CAPSULE_RESUME_PLAN_CONTRACT,
    mode: "shadow-only",
    productionAuthority: "v3",
    evaluatedAt: request.evaluatedAt,
    decisions,
    requiredRestores,
    requiredStages,
    requiredEffects: structuredClone(request.effects),
  };
  return {
    ...payload,
    planRoot: v4ContentRoot("stage-capsule-resume-plan", payload),
  };
}
