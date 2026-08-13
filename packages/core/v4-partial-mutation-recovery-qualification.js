import {
  V4ContractFault,
  v4ContentRoot,
  validateV4Clock,
  validateV4Root,
} from "./v4-canonical-contracts.js";

export const V4_PARTIAL_MUTATION_RECOVERY_REQUEST_CONTRACT =
  "buildchain-v4-partial-mutation-recovery-request/v1";
export const V4_PARTIAL_MUTATION_RECOVERY_PLAN_CONTRACT =
  "buildchain-v4-partial-mutation-recovery-plan/v1";

const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PHASES = new Set([
  "planned",
  "intended",
  "attempting",
  "observed",
  "confirmable",
  "retryable",
  "confirmed",
  "rejected",
  "terminal",
]);
const PRIORITY = new Map(
  ["escalate", "compensate", "reconcile", "wait", "retry"].map(
    (value, index) => [value, index],
  ),
);

function fault(code, path, message) {
  throw new V4ContractFault(code, path, message);
}

function exactKeys(value, expected, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault("invalid-partial-mutation-recovery-shape", path, "object required");
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  )
    fault(
      "invalid-partial-mutation-recovery-shape",
      path,
      "keys do not match the closed recovery contract",
    );
}

function token(value, path) {
  if (typeof value !== "string" || !TOKEN.test(value))
    fault(
      "invalid-partial-mutation-recovery-token",
      path,
      "recovery identifiers must be ASCII tokens",
    );
}

function sortedUnique(values, path, validate) {
  if (!Array.isArray(values))
    fault("invalid-partial-mutation-recovery-shape", path, "array required");
  let prior = null;
  for (const [index, value] of values.entries()) {
    validate(value, `${path}/${index}`);
    if (prior !== null && value <= prior)
      fault(
        "unordered-partial-mutation-recovery-evidence",
        `${path}/${index}`,
        "values must be unique and byte-sorted",
      );
    prior = value;
  }
}

function validateStageResume(value, request) {
  exactKeys(
    value,
    [
      "schema",
      "planRoot",
      "sourceRoot",
      "policyRoot",
      "platformRoot",
      "qualificationRoots",
      "decisions",
    ],
    "$/stageResume",
  );
  if (value.schema !== "buildchain-v4-stage-capsule-resume-evidence/v1")
    fault(
      "unsupported-partial-mutation-recovery-version",
      "$/stageResume/schema",
      "unsupported Stage Capsule resume evidence",
    );
  for (const [field, expected] of [
    ["sourceRoot", request.sourceRoot],
    ["policyRoot", request.policyRoot],
    ["platformRoot", request.platformRoot],
  ]) {
    validateV4Root(value[field], `$/stageResume/${field}`);
    if (value[field] !== expected)
      fault(
        "partial-mutation-recovery-binding-mismatch",
        `$/stageResume/${field}`,
        `Stage Capsule ${field} drifted from the recovery request`,
      );
  }
  validateV4Root(value.planRoot, "$/stageResume/planRoot");
  sortedUnique(
    value.qualificationRoots,
    "$/stageResume/qualificationRoots",
    validateV4Root,
  );
  if (value.qualificationRoots.length === 0)
    fault(
      "missing-partial-mutation-recovery-evidence",
      "$/stageResume/qualificationRoots",
      "Stage Capsule qualification roots are required",
    );
  if (!Array.isArray(value.decisions) || value.decisions.length === 0)
    fault(
      "missing-partial-mutation-recovery-evidence",
      "$/stageResume/decisions",
      "Stage Capsule decisions are required",
    );
  let prior = null;
  for (const [index, decision] of value.decisions.entries()) {
    const path = `$/stageResume/decisions/${index}`;
    exactKeys(decision, ["stageKey", "decision", "reasonCode"], path);
    token(decision.stageKey, `${path}/stageKey`);
    token(decision.reasonCode, `${path}/reasonCode`);
    if (!new Set(["reuse", "rebuild", "reject"]).has(decision.decision))
      fault(
        "invalid-partial-mutation-recovery-stage-decision",
        `${path}/decision`,
        "unsupported Stage Capsule decision",
      );
    if (prior !== null && decision.stageKey <= prior)
      fault(
        "unordered-partial-mutation-recovery-evidence",
        `${path}/stageKey`,
        "stage decisions must be unique and byte-sorted",
      );
    prior = decision.stageKey;
  }
}

function validateActivation(value, request) {
  exactKeys(
    value,
    [
      "schema",
      "planRoot",
      "stateRoot",
      "qualificationRoot",
      "policyRoot",
      "steps",
    ],
    "$/activation",
  );
  if (value.schema !== "buildchain-v4-release-activation-recovery-evidence/v1")
    fault(
      "unsupported-partial-mutation-recovery-version",
      "$/activation/schema",
      "unsupported release activation evidence",
    );
  for (const field of [
    "planRoot",
    "stateRoot",
    "qualificationRoot",
    "policyRoot",
  ])
    validateV4Root(value[field], `$/activation/${field}`);
  if (
    value.qualificationRoot !== request.qualificationRoot ||
    value.policyRoot !== request.policyRoot
  )
    fault(
      "partial-mutation-recovery-binding-mismatch",
      "$/activation",
      "activation qualification or policy root drifted",
    );
  if (!Array.isArray(value.steps) || value.steps.length === 0)
    fault(
      "missing-partial-mutation-recovery-evidence",
      "$/activation/steps",
      "activation steps are required",
    );
  let prior = null;
  const operationRoots = new Set();
  for (const [index, step] of value.steps.entries()) {
    const path = `$/activation/steps/${index}`;
    exactKeys(
      step,
      [
        "stepId",
        "operationRoot",
        "phase",
        "journalRoot",
        "journalStateRoot",
        "compensationBoundaryRoot",
        "attemptCount",
      ],
      path,
    );
    token(step.stepId, `${path}/stepId`);
    for (const field of ["operationRoot", "compensationBoundaryRoot"])
      validateV4Root(step[field], `${path}/${field}`);
    if (operationRoots.has(step.operationRoot))
      fault(
        "conflicting-partial-mutation-recovery-evidence",
        `${path}/operationRoot`,
        "activation steps must bind unique provider operations",
      );
    operationRoots.add(step.operationRoot);
    if (!PHASES.has(step.phase))
      fault(
        "unknown-partial-mutation-recovery-phase",
        `${path}/phase`,
        "operation phase is not in the closed recovery state set",
      );
    if (!Number.isSafeInteger(step.attemptCount) || step.attemptCount < 0)
      fault(
        "invalid-partial-mutation-recovery-attempt-count",
        `${path}/attemptCount`,
        "attempt count must be a non-negative safe integer",
      );
    const rootsRequired = step.phase !== "planned";
    for (const field of ["journalRoot", "journalStateRoot"])
      if (rootsRequired) validateV4Root(step[field], `${path}/${field}`);
      else if (step[field] !== null)
        fault(
          "conflicting-partial-mutation-recovery-evidence",
          `${path}/${field}`,
          "planned operations cannot claim retained journal roots",
        );
    if (step.phase === "attempting" && step.attemptCount === 0)
      fault(
        "conflicting-partial-mutation-recovery-evidence",
        `${path}/attemptCount`,
        "attempting requires a retained attempt",
      );
    if (prior !== null && step.stepId <= prior)
      fault(
        "unordered-partial-mutation-recovery-evidence",
        `${path}/stepId`,
        "activation steps must be unique and byte-sorted",
      );
    prior = step.stepId;
  }
}

function validateRequest(request) {
  exactKeys(
    request,
    [
      "schema",
      "evaluatedAt",
      "sourceRoot",
      "policyRoot",
      "platformRoot",
      "qualificationRoot",
      "maxAttempts",
      "compensableBoundaryRoots",
      "stageResume",
      "activation",
    ],
    "$",
  );
  if (request.schema !== V4_PARTIAL_MUTATION_RECOVERY_REQUEST_CONTRACT)
    fault(
      "unsupported-partial-mutation-recovery-version",
      "$/schema",
      "unsupported partial-mutation recovery request",
    );
  validateV4Clock(request.evaluatedAt, "$/evaluatedAt");
  for (const field of [
    "sourceRoot",
    "policyRoot",
    "platformRoot",
    "qualificationRoot",
  ])
    validateV4Root(request[field], `$/` + field);
  if (!Number.isSafeInteger(request.maxAttempts) || request.maxAttempts < 1)
    fault(
      "invalid-partial-mutation-recovery-attempt-budget",
      "$/maxAttempts",
      "maxAttempts must be a positive safe integer",
    );
  sortedUnique(
    request.compensableBoundaryRoots,
    "$/compensableBoundaryRoots",
    validateV4Root,
  );
  validateStageResume(request.stageResume, request);
  validateActivation(request.activation, request);
}

function checkpoint(kind, id, root) {
  const payload = { kind, id, root };
  return {
    ...payload,
    checkpointRoot: v4ContentRoot(
      "partial-mutation-recovery-checkpoint",
      payload,
    ),
  };
}

function operationDecision(step, request) {
  if (step.phase === "confirmed") return null;
  let action;
  if (["rejected", "terminal"].includes(step.phase))
    action = request.compensableBoundaryRoots.includes(
      step.compensationBoundaryRoot,
    )
      ? "compensate"
      : "escalate";
  else if (step.attemptCount >= request.maxAttempts) action = "escalate";
  else if (["observed", "confirmable"].includes(step.phase))
    action = "reconcile";
  else if (step.phase === "attempting") action = "wait";
  else action = "retry";
  const retainedRoot = step.journalStateRoot ?? step.operationRoot;
  return {
    stepId: step.stepId,
    operationRoot: step.operationRoot,
    action,
    checkpoint: checkpoint("provider-operation", step.stepId, retainedRoot),
  };
}

export function planV4PartialMutationRecovery(request) {
  validateRequest(request);
  const stageFailures = request.stageResume.decisions.filter(
    ({ decision }) => decision !== "reuse",
  );
  let nextOperations = request.activation.steps
    .map((step) => operationDecision(step, request))
    .filter(Boolean);
  if (stageFailures.length > 0) {
    const first = stageFailures[0];
    nextOperations = [
      {
        stepId: first.stageKey,
        operationRoot: null,
        action: "escalate",
        checkpoint: checkpoint(
          "stage-capsule",
          first.stageKey,
          request.stageResume.planRoot,
        ),
      },
    ];
  }
  nextOperations.sort((left, right) => {
    const priority = PRIORITY.get(left.action) - PRIORITY.get(right.action);
    if (priority !== 0) return priority;
    return left.stepId < right.stepId ? -1 : left.stepId > right.stepId ? 1 : 0;
  });
  const classification = nextOperations[0]?.action ?? "terminal-noop";
  const terminalOperationRoots = request.activation.steps
    .filter(({ phase }) => phase === "confirmed")
    .map(({ operationRoot }) => operationRoot)
    .sort();
  const payload = {
    schema: V4_PARTIAL_MUTATION_RECOVERY_PLAN_CONTRACT,
    mode: "production",
    productionAuthority: "v4",
    evaluatedAt: request.evaluatedAt,
    sourceRoot: request.sourceRoot,
    policyRoot: request.policyRoot,
    platformRoot: request.platformRoot,
    qualificationRoot: request.qualificationRoot,
    stageResumePlanRoot: request.stageResume.planRoot,
    activationPlanRoot: request.activation.planRoot,
    activationStateRoot: request.activation.stateRoot,
    classification,
    unresolvedCheckpoint: nextOperations[0]?.checkpoint ?? null,
    nextOperations,
    terminalOperationRoots,
    zeroExternalMutations: true,
    complexity: {
      stageDecisionCount: request.stageResume.decisions.length,
      operationCount: request.activation.steps.length,
      nextOperationCount: nextOperations.length,
      externalMutationCount: 0,
    },
  };
  return {
    ...payload,
    planRoot: v4ContentRoot("partial-mutation-recovery-plan", payload),
  };
}
