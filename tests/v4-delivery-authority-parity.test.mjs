import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  closeDevDeliveryWarrant,
  createDevDeliveryQueue,
  createIntegrationDeliveryProof,
  createNativeCommandContract,
  createNativeExecutionReceipt,
  createNativeProofReuseDecision,
  createNativeQualificationProof,
  createSourceQualificationProof,
  devDeliveryContentRoot,
  heartbeatDevDeliveryWarrant,
  qualifyDevDeliveryWarrant,
  recoverExpiredDevDeliveryWarrant,
  selectDevDeliveryWarrant,
  submitDevDeliveryCandidate,
  verifyIntegrationDeliveryProof,
  verifyNativeQualificationProof,
} from "../packages/core/dev-delivery-warrant.js";
import {
  acquireDevDeliveryLandingWarrant,
  acquireDevDeliveryQualificationLease,
  admitDevDeliveryMergeGroup,
  completeDevDeliveryQualification,
  createDevDeliveryAuthorityState,
  createDevDeliveryQualificationContract,
  migrateDevDeliveryAuthorityState,
  recoverDevDeliveryAuthority,
  settleDevDeliveryAuthorityCandidate,
  submitDevDeliveryAuthorityCandidate,
} from "../packages/core/dev-delivery-authority-landing.js";
import {
  DEV_DELIVERY_TESTING_PROVIDER_READBACK,
  admitDevDeliveryMergeGroupForTesting,
  sealLandingTerminalReadbackForTesting,
} from "../packages/core/dev-delivery-landing-testing-port.js";
import {
  devDeliveryAuthorityCliOptions,
  runDevDeliveryAuthorityCommand,
} from "../scripts/dev-delivery-authority.mjs";
import { parseWorkflowDocument } from "../packages/core/workflow-yaml-contract.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const matrixPath = path.join(
  repositoryRoot,
  "architecture/v4-delivery-authority-parity.json",
);
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));

test("rooted v4 Delivery Authority matrix accounts for every declared invariant", () => {
  const body = structuredClone(matrix);
  delete body.matrixRoot;
  assert.equal(matrix.matrixRoot, devDeliveryContentRoot(body));
  assert.equal(
    matrix.contract,
    "kungfu-buildchain-v4-delivery-authority-parity",
  );
  assert.equal(
    matrix.sourceAuthority.decision,
    "architecture/decisions/0003-two-phase-delivery-warrant.md",
  );
  assert.equal(matrix.target.branch, "dev/v4/v4.0");
  assert.deepEqual(
    matrix.invariants.map(({ id }) => id),
    Array.from(
      { length: 16 },
      (_, index) => `DA-${String(index + 1).padStart(2, "0")}`,
    ),
  );
  assert.equal(
    new Set(matrix.invariants.map(({ id }) => id)).size,
    matrix.invariants.length,
  );

  const allowed = new Set(matrix.allowedDispositions);
  for (const invariant of matrix.invariants) {
    assert.ok(
      allowed.has(invariant.disposition),
      `${invariant.id} has a declared disposition`,
    );
    assert.ok(
      invariant.claim.length > 40,
      `${invariant.id} states a semantic invariant, not only a name`,
    );
    if (invariant.disposition !== "missing-before-closeout") {
      assert.ok(
        invariant.implementationEvidence.length > 0,
        `${invariant.id} has implementation evidence`,
      );
      assert.ok(
        invariant.verificationEvidence.length > 0,
        `${invariant.id} has verification evidence`,
      );
      assert.equal(
        typeof invariant.behavioralProof,
        "string",
        `${invariant.id} names its executable behavioral proof`,
      );
    }
  }
});

test("external closeout evidence remains explicit and cannot be inferred from local green tests", () => {
  const missing = matrix.invariants.filter(
    ({ disposition }) => disposition === "missing-before-closeout",
  );
  assert.deepEqual(
    missing.map(({ id }) => id),
    ["DA-16"],
  );
  assert.match(missing[0].claim, /Independent review/u);
  assert.match(missing[0].claim, /protected merge/u);
  assert.match(missing[0].claim, /post-merge readback/u);
});

const root = (digit) => `sha256:${digit.repeat(64)}`;
const SOURCE_HEAD = "a".repeat(40);
const QUALIFIED_BASE = "b".repeat(40);
const NATIVE_COMMAND_CONTRACT = createNativeCommandContract("native-shards");

function legacyCandidate(number, overrides = {}) {
  const input = {
    pullRequestNumber: number,
    sourceHead: SOURCE_HEAD,
    assignmentRoot: root("1"),
    initiativeRoot: root("2"),
    sourceIdentityRoot: root("3"),
    sourcePatchRoot: root("4"),
    planRoot: root("6"),
    closureRoot: root("7"),
    dependencyRoot: root("8"),
    toolchainRoot: root("9"),
    environmentRoot: root("a"),
    nativeCommandContract: NATIVE_COMMAND_CONTRACT,
    affectedPaths: ["packages/native"],
    shardEvidenceRoots: [root("c")],
    deliveryClass: "native-proof-required",
    priority: "ordinary",
    ...overrides,
  };
  const sourceProof = sourceProofFor(input);
  return { ...input, sourceProofRoot: sourceProof.proofRoot };
}

function providerAttemptFor(sourceHead, mergeGroupHead) {
  return {
    schema: "kungfu.buildchain.github-landing-provider-attempt/v1",
    repository: "kungfu-systems/buildchain",
    workflowId: 700,
    workflowPath: ".github/workflows/dev-pr-auto-merge.yml",
    workflowRef:
      "kungfu-systems/buildchain/.github/workflows/dev-pr-auto-merge.yml@refs/tags/v4-alpha",
    workflowSha: "c".repeat(40),
    event: "merge_group",
    runId: 1500,
    runAttempt: 1,
    jobId: 1501,
    jobName: "Credentialed provider finalizer",
    jobRole: "landing-authority",
    runnerId: 1502,
    runnerName: "GitHub Actions 1502",
    runnerGroupId: 1,
    runnerGroupName: "GitHub Actions",
    runnerLabels: ["X64", "ubuntu-24.04"],
    sourceHead,
    mergeGroupHead,
    protectedBase: "dev/v4/v4.0",
  };
}

function sourceProofFor(input, repository = "kungfu-systems/buildchain") {
  return createSourceQualificationProof({
    repository,
    protectedBase: "dev/v4/v4.0",
    sourceIdentityRoot: input.sourceIdentityRoot,
    sourceHead: input.sourceHead,
    sourcePatchRoot: input.sourcePatchRoot,
    planRoot: input.planRoot,
    closureRoot: input.closureRoot,
    dependencyRoot: input.dependencyRoot,
    toolchainRoot: input.toolchainRoot,
    affectedPaths: input.affectedPaths,
    shardEvidenceRoots: input.shardEvidenceRoots,
    qualifiedAt: "2026-08-15T00:00:00Z",
  });
}

function nativeProof(overrides = {}) {
  const executionReceipt = createNativeExecutionReceipt({
    outcome: "succeeded",
    commandRoot: NATIVE_COMMAND_CONTRACT.commandRoot,
    executionBinding: {
      repository: "kungfu-systems/buildchain",
      protectedBase: "dev/v4/v4.0",
      sourceHead: SOURCE_HEAD,
      qualifiedBase: QUALIFIED_BASE,
      nativeCommandRoot: NATIVE_COMMAND_CONTRACT.commandRoot,
      toolchainRoot: root("9"),
      environmentRoot: root("a"),
    },
    startedAt: "2026-08-15T00:00:10Z",
    completedAt: "2026-08-15T00:00:20Z",
    heartbeatCount: 2,
  });
  return createNativeQualificationProof({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v4/v4.0",
    sourceHead: SOURCE_HEAD,
    sourceIdentityRoot: root("3"),
    sourcePatchRoot: root("4"),
    planRoot: root("6"),
    closureRoot: root("7"),
    dependencyRoot: root("8"),
    toolchainRoot: root("9"),
    environmentRoot: root("a"),
    nativeCommandRoot: NATIVE_COMMAND_CONTRACT.commandRoot,
    qualifiedBase: QUALIFIED_BASE,
    nativeExecutionReceipt: executionReceipt,
    affectedPaths: ["packages/native"],
    shardEvidenceRoots: [root("c")],
    qualifiedAt: "2026-08-15T00:00:21Z",
    ...overrides,
  });
}

function reuseCurrent(overrides = {}) {
  return {
    sourceHead: SOURCE_HEAD,
    sourceIdentityRoot: root("3"),
    sourcePatchRoot: root("4"),
    planRoot: root("6"),
    closureRoot: root("7"),
    dependencyRoot: root("8"),
    toolchainRoot: root("9"),
    environmentRoot: root("a"),
    nativeCommandRoot: NATIVE_COMMAND_CONTRACT.commandRoot,
    currentBase: QUALIFIED_BASE,
    graphKnown: true,
    attributionComplete: true,
    changedPaths: [],
    renames: [],
    ...overrides,
  };
}

function authorityCandidate(number, domain) {
  return legacyCandidate(number, {
    sourceHead: number.toString(16).slice(-1).repeat(40),
    sourceIdentityRoot: root(number.toString(16).slice(-1)),
    qualificationDomains: [domain],
  });
}

function authorityQualificationEvidence(state, lease) {
  const candidate = state.candidates.find(
    (entry) => entry.candidateId === lease.candidateId,
  );
  const sourceProof = sourceProofFor(candidate);
  const nativeExecutionReceipt = createNativeExecutionReceipt({
    outcome: "succeeded",
    commandRoot: candidate.nativeCommandContract.commandRoot,
    executionBinding: {
      repository: state.repository,
      protectedBase: state.protectedBase,
      sourceHead: candidate.sourceHead,
      qualifiedBase: QUALIFIED_BASE,
      nativeCommandRoot: candidate.nativeCommandContract.commandRoot,
      toolchainRoot: candidate.toolchainRoot,
      environmentRoot: candidate.environmentRoot,
    },
    startedAt: "2026-08-15T00:00:10Z",
    completedAt: "2026-08-15T00:00:20Z",
    heartbeatCount: 2,
  });
  const nativeProof = createNativeQualificationProof({
    repository: state.repository,
    protectedBase: state.protectedBase,
    sourceIdentityRoot: candidate.sourceIdentityRoot,
    sourcePatchRoot: candidate.sourcePatchRoot,
    planRoot: candidate.planRoot,
    closureRoot: candidate.closureRoot,
    dependencyRoot: candidate.dependencyRoot,
    toolchainRoot: candidate.toolchainRoot,
    environmentRoot: candidate.environmentRoot,
    sourceHead: candidate.sourceHead,
    qualifiedBase: QUALIFIED_BASE,
    nativeCommandRoot: candidate.nativeCommandContract.commandRoot,
    nativeExecutionReceipt,
    affectedPaths: candidate.affectedPaths,
    shardEvidenceRoots: candidate.shardEvidenceRoots,
    qualifiedAt: "2026-08-15T00:00:21Z",
  });
  const qualificationContract = createDevDeliveryQualificationContract({
    state,
    candidate,
    lease,
    sourceProof,
    nativeProof,
  });
  return { sourceProof, nativeProof, qualificationContract };
}

function rejected(call, pattern) {
  try {
    call();
  } catch (error) {
    assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`expected rejection matching ${pattern}`);
}

function reusableWorkflowCall(source) {
  const call = parseWorkflowDocument(source).callJobs.find(
    ({ id }) => id === "deliver",
  );
  assert.ok(call, "delivery workflow has one semantic reusable-workflow call");
  return call;
}

function splitExpression(value, operator) {
  const parts = [];
  let quote = "";
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === "'" || character === '"') && value[index - 1] !== "\\") {
      quote = quote === character ? "" : quote || character;
    } else if (!quote && character === "(") {
      depth += 1;
    } else if (!quote && character === ")") {
      depth -= 1;
    } else if (
      !quote &&
      depth === 0 &&
      value.slice(index, index + operator.length) === operator
    ) {
      parts.push(value.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function contextValue(context, pathExpression) {
  return pathExpression
    .split(".")
    .reduce((value, key) => value?.[key], context);
}

function evaluateExpression(expression, context) {
  const value = expression.trim();
  const alternatives = splitExpression(value, "||");
  if (alternatives.length > 1) {
    let result;
    for (const alternative of alternatives) {
      result = evaluateExpression(alternative, context);
      if (result) return result;
    }
    return result;
  }
  const conditions = splitExpression(value, "&&");
  if (conditions.length > 1) {
    let result;
    for (const condition of conditions) {
      result = evaluateExpression(condition, context);
      if (!result) return result;
    }
    return result;
  }
  const equality = splitExpression(value, "==");
  if (equality.length > 1) {
    assert.equal(equality.length, 2);
    return (
      evaluateExpression(equality[0], context) ===
      evaluateExpression(equality[1], context)
    );
  }
  const call = value.match(/^(toJSON|fromJSON)\(([\s\S]*)\)$/u);
  if (call) {
    const argument = evaluateExpression(call[2], context);
    return call[1] === "toJSON"
      ? JSON.stringify(argument)
      : JSON.parse(argument);
  }
  if (
    value.length >= 2 &&
    value[0] === value.at(-1) &&
    ["'", '"'].includes(value[0])
  ) {
    return value.slice(1, -1);
  }
  if (/^(true|false)$/u.test(value)) return value === "true";
  if (/^-?\d+$/u.test(value)) return Number(value);
  if (/^(github|inputs)(?:\.[A-Za-z0-9_-]+)+$/u.test(value)) {
    return contextValue(context, value);
  }
  throw new Error(`unsupported workflow expression atom: ${value}`);
}

function evaluateWorkflowInput(scalar, context) {
  if (scalar.kind !== "expression") return scalar.value;
  return evaluateExpression(
    scalar.value.replace(/^\$\{\{\s*/u, "").replace(/\s*\}\}$/u, ""),
    context,
  );
}

function executeWorkflowMapping(call, context, names) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      evaluateWorkflowInput(call.with[name], context),
    ]),
  );
}

test("every implemented parity disposition has an executable behavioral proof", async () => {
  const proved = new Set();
  const prove = (id, condition) => {
    assert.equal(condition, true, `${id} behavioral disposition`);
    proved.add(id);
  };

  const initial = createDevDeliveryQueue({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v4/v4.0",
    policy: { leaseSeconds: 60 },
    now: "2026-08-15T00:00:00Z",
  });
  const submitted = submitDevDeliveryCandidate(initial, legacyCandidate(401), {
    now: "2026-08-15T00:00:01Z",
  });
  const selected = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-15T00:00:02Z",
  });
  prove(
    "DA-01",
    selected.warrant.phase === "provisional" &&
      selected.queue.candidates[0].status === "selected",
  );
  const staleHeartbeat = rejected(
    () =>
      heartbeatDevDeliveryWarrant(
        selected.queue,
        { ...selected.warrant, fencingToken: root("f") },
        { now: "2026-08-15T00:00:03Z" },
      ),
    /stale fencing token/u,
  );
  prove("DA-02", staleHeartbeat.message === "stale fencing token");

  const proof = nativeProof();
  const withoutReceipt = structuredClone(proof);
  delete withoutReceipt.nativeExecutionReceipt;
  const withoutReceiptIdentity = structuredClone(withoutReceipt);
  delete withoutReceiptIdentity.proofRoot;
  delete withoutReceiptIdentity.qualifiedAt;
  delete withoutReceiptIdentity.observationRoot;
  withoutReceipt.proofRoot = devDeliveryContentRoot(withoutReceiptIdentity);
  prove(
    "DA-03",
    verifyNativeQualificationProof(proof).ok === true &&
      verifyNativeQualificationProof(withoutReceipt).reason ===
        "native-execution-receipt-bytes-missing",
  );
  const reusable = createNativeProofReuseDecision({
    proof,
    current: reuseCurrent(),
  });
  const overlapping = createNativeProofReuseDecision({
    proof,
    current: reuseCurrent({
      currentBase: "c".repeat(40),
      changedPaths: ["packages/native/runtime.cc"],
    }),
  });
  prove("DA-04", reusable.reusable && !overlapping.reusable);

  const qualified = qualifyDevDeliveryWarrant(
    selected.queue,
    selected.warrant,
    {
      nativeProof: proof,
      reuseDecision: reusable,
      current: reuseCurrent(),
      now: "2026-08-15T00:00:22Z",
    },
  );
  prove(
    "DA-05",
    qualified.warrant.phase === "qualified" &&
      qualified.warrant.fencingToken === selected.warrant.fencingToken &&
      qualified.warrant.generation === selected.warrant.generation,
  );
  const expired = recoverExpiredDevDeliveryWarrant(selected.queue, {
    now: "2026-08-15T00:02:00Z",
  });
  prove(
    "DA-06",
    expired.receipt.action === "expired-lease-fenced-stop-required" &&
      expired.queue.stateRoot === selected.queue.stateRoot,
  );
  const integration = createIntegrationDeliveryProof({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v4/v4.0",
    sourceProofRoot: root("5"),
    currentBase: QUALIFIED_BASE,
    replayTree: "c".repeat(40),
    mergeGroupHead: "d".repeat(40),
    mergeGroupTree: "e".repeat(40),
    warrant: qualified.warrant,
    requiredContextRoots: [root("d")],
    verifiedAt: "2026-08-15T00:00:23Z",
  });
  prove(
    "DA-07",
    verifyIntegrationDeliveryProof(integration).ok &&
      integration.finalAuthority === "exact-github-merge-group",
  );

  let authority = createDevDeliveryAuthorityState({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v4/v4.0",
    policy: {
      maxQualificationLeases: 4,
      maxLandingOvertakes: 0,
      qualificationLeaseSeconds: 60,
      landingLeaseSeconds: 10,
    },
    now: "2026-08-15T01:00:00Z",
  });
  const slow = authorityCandidate(402, root("1"));
  const fast = authorityCandidate(403, root("2"));
  const overlappingCandidate = authorityCandidate(404, root("1"));
  const unknownCandidate = authorityCandidate(405, undefined);
  unknownCandidate.qualificationDomains = [];
  authority = submitDevDeliveryAuthorityCandidate(authority, slow, {
    now: "2026-08-15T01:00:01Z",
  }).state;
  authority = submitDevDeliveryAuthorityCandidate(authority, fast, {
    now: "2026-08-15T01:00:02Z",
  }).state;
  authority = submitDevDeliveryAuthorityCandidate(
    authority,
    overlappingCandidate,
    {
      now: "2026-08-15T01:00:02.100Z",
    },
  ).state;
  authority = submitDevDeliveryAuthorityCandidate(authority, unknownCandidate, {
    now: "2026-08-15T01:00:02.200Z",
  }).state;
  const slowLease = acquireDevDeliveryQualificationLease(authority, {
    now: "2026-08-15T01:00:03Z",
  });
  const fastLease = acquireDevDeliveryQualificationLease(slowLease.state, {
    now: "2026-08-15T01:00:04Z",
  });
  const safetyBlocked = acquireDevDeliveryQualificationLease(fastLease.state, {
    now: "2026-08-15T01:00:04.500Z",
  });
  prove(
    "DA-08",
    fastLease.state.qualificationLeases.length === 2 &&
      fastLease.state.qualificationLeases.every(
        (lease) => lease.mergeGroupAdmission === false,
      ) &&
      safetyBlocked.lease === null &&
      safetyBlocked.receipt.blockedReasons.map(({ code }) => code).join(",") ===
        "overlapping-qualification-domain,unknown-qualification-domain",
  );
  const qualificationAdmission = rejected(
    () =>
      admitDevDeliveryMergeGroupForTesting(fastLease.state, slowLease.lease, {
        mergeGroupHead: "f".repeat(40),
        now: "2026-08-15T01:00:05Z",
      }),
    /Qualification Lease cannot admit merge_group/u,
  );
  prove(
    "DA-09",
    qualificationAdmission.message ===
      "Qualification Lease cannot admit merge_group",
  );
  const fastQualified = completeDevDeliveryQualification(
    fastLease.state,
    fastLease.lease,
    {
      ...authorityQualificationEvidence(fastLease.state, fastLease.lease),
      now: "2026-08-15T01:00:06Z",
    },
  );
  const overtakingBlocked = acquireDevDeliveryLandingWarrant(
    fastQualified.state,
    { now: "2026-08-15T01:00:07Z" },
  );
  const slowQualified = completeDevDeliveryQualification(
    overtakingBlocked.state,
    slowLease.lease,
    {
      ...authorityQualificationEvidence(
        overtakingBlocked.state,
        slowLease.lease,
      ),
      now: "2026-08-15T01:00:08Z",
    },
  );
  const landing = acquireDevDeliveryLandingWarrant(slowQualified.state, {
    now: "2026-08-15T01:00:09Z",
    leaseSeconds: 10,
  });
  const competingLanding = acquireDevDeliveryLandingWarrant(landing.state, {
    now: "2026-08-15T01:00:09.500Z",
  });
  prove(
    "DA-10",
    overtakingBlocked.warrant === null &&
      overtakingBlocked.receipt.action === "landing-overtake-bound-noop" &&
      competingLanding.receipt.action ===
        "exclusive-landing-warrant-retained-noop" &&
      competingLanding.warrant.token === landing.warrant.token &&
      competingLanding.state.candidates.filter(
        ({ status }) => status === "landing",
      ).length === 1,
  );
  const mergeGroupHead = "f".repeat(40);
  const admittedLanding = admitDevDeliveryMergeGroupForTesting(
    landing.state,
    landing.warrant,
    {
      mergeGroupHead,
      providerAttempt: providerAttemptFor(slow.sourceHead, mergeGroupHead),
      now: "2026-08-15T01:00:09.750Z",
    },
  );
  const retainedLanding = recoverDevDeliveryAuthority(admittedLanding.state, {
    now: "2026-08-15T01:00:20Z",
  });
  const providerReadback = sealLandingTerminalReadbackForTesting({
    repository: retainedLanding.state.repository,
    protectedBase: retainedLanding.state.protectedBase,
    stateRoot: retainedLanding.state.stateRoot,
    candidateId: landing.warrant.candidateId,
    pullRequestNumber: slow.pullRequestNumber,
    sourceHead: slow.sourceHead,
    landingWarrantToken: landing.warrant.token,
    landingWarrantGeneration: landing.warrant.generation,
    providerRunId: 1500,
    providerRunAttempt: 1,
    providerRunState: "completed",
    providerRunConclusion: "failure",
    providerRunHead: mergeGroupHead,
    providerJobId: 1501,
    providerJobState: "completed",
    providerJobConclusion: "failure",
    providerJobStartedAt: "2026-08-15T01:00:10Z",
    providerJobCompletedAt: "2026-08-15T01:00:19Z",
    providerAttempt: admittedLanding.state.landingWarrant.providerAttempt,
    admissionRoot: admittedLanding.admissionRoot,
    pullRequestState: "open",
    pullRequestMerged: false,
    protectedBaseHead: "e".repeat(40),
    providerRunHeadInProtectedBase: false,
    outcome: "terminal-failure",
    reason: "provider-stop-readback",
    observedAt: "2026-08-15T01:00:20Z",
  });
  const landingSettled = settleDevDeliveryAuthorityCandidate(
    retainedLanding.state,
    {
      pullRequestNumber: slow.pullRequestNumber,
      sourceHead: slow.sourceHead,
      outcome: "terminal-failure",
      evidenceRoot: providerReadback.evidenceRoot,
      authorityToken: landing.warrant.token,
      authorityGeneration: landing.warrant.generation,
      providerRunId: 1500,
      providerJobId: 1501,
      reason: "provider-stop-readback",
    },
    {
      now: "2026-08-15T01:00:21Z",
      [DEV_DELIVERY_TESTING_PROVIDER_READBACK]: providerReadback,
    },
  );
  const duplicateLandingSettlement = settleDevDeliveryAuthorityCandidate(
    landingSettled.state,
    {
      pullRequestNumber: slow.pullRequestNumber,
      sourceHead: slow.sourceHead,
      outcome: "terminal-failure",
      evidenceRoot: providerReadback.evidenceRoot,
    },
    { now: "2026-08-15T01:00:22Z" },
  );
  prove(
    "DA-11",
    retainedLanding.state.stateRoot === admittedLanding.state.stateRoot &&
      retainedLanding.state.landingWarrant.token === landing.warrant.token &&
      landingSettled.state.landingWarrant === null &&
      duplicateLandingSettlement.receipt.action ===
        "duplicate-terminal-event-noop" &&
      duplicateLandingSettlement.state.stateRoot ===
        landingSettled.state.stateRoot,
  );

  const persistedInitial = createDevDeliveryAuthorityState({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v4/v4.0",
    now: "2026-08-15T01:30:00Z",
  });
  const writes = [];
  const store = {
    async read() {
      return {
        exists: true,
        commitSha: "a".repeat(40),
        queue: persistedInitial,
      };
    },
    async write(input) {
      writes.push(input);
      return { commitSha: "b".repeat(40), stateRoot: input.queue.stateRoot };
    },
  };
  const persisted = await runDevDeliveryAuthorityCommand(
    {
      command: "submit",
      repository: "kungfu-systems/buildchain",
      branch: "dev/v4/v4.0",
      now: "2026-08-15T01:30:01Z",
      execute: true,
      ...authorityCandidate(406, root("6")),
    },
    store,
  );
  await assert.rejects(
    runDevDeliveryAuthorityCommand(
      {
        command: "submit",
        repository: "kungfu-systems/buildchain",
        branch: "dev/v4/v4.0",
        now: "2026-08-15T01:30:02Z",
        execute: true,
        expectedOldStateRoot: root("f"),
        ...authorityCandidate(407, root("7")),
      },
      store,
    ),
    /expected-old state drift/u,
  );
  prove(
    "DA-12",
    persisted.mutationApplied === true &&
      writes.length === 1 &&
      writes[0].expectedCommitSha === "a".repeat(40) &&
      writes[0].expectedStateRoot === persistedInitial.stateRoot &&
      persisted.receipt.expectedOldStateRoot === persistedInitial.stateRoot,
  );

  const migrated = migrateDevDeliveryAuthorityState(selected.queue, {
    now: "2026-08-15T02:00:00Z",
  });
  const migratedAdmission = rejected(
    () =>
      admitDevDeliveryMergeGroupForTesting(
        migrated.state,
        migrated.state.qualificationLeases[0],
        {
          mergeGroupHead: "f".repeat(40),
          now: "2026-08-15T02:00:01Z",
        },
      ),
    /Qualification Lease cannot admit merge_group/u,
  );
  prove(
    "DA-13",
    migrated.receipt.legacyStateRoot === selected.queue.stateRoot &&
      migrated.state.qualificationLeases[0].token ===
        selected.warrant.fencingToken &&
      migrated.state.landingWarrant === null &&
      migratedAdmission.message ===
        "Qualification Lease cannot admit merge_group",
  );
  const legacyProof = structuredClone(proof);
  legacyProof.schema = "kungfu.buildchain.native-qualification-proof/v1";
  for (const field of [
    "environmentRoot",
    "sourceHead",
    "nativeExecutionBindingRoot",
    "nativeExecutionReceiptRoot",
    "nativeExecutionReceipt",
  ])
    delete legacyProof[field];
  const legacyIdentity = structuredClone(legacyProof);
  delete legacyIdentity.proofRoot;
  delete legacyIdentity.qualifiedAt;
  delete legacyIdentity.observationRoot;
  legacyProof.proofRoot = devDeliveryContentRoot(legacyIdentity);
  prove(
    "DA-14",
    verifyNativeQualificationProof(legacyProof).ok &&
      !createNativeProofReuseDecision({
        proof: legacyProof,
        current: reuseCurrent(),
      }).reusable,
  );

  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        "contracts/dev-delivery-authority-v2.schema.json",
      ),
      "utf8",
    ),
  );
  const validate = new Ajv2020({
    strict: false,
    formats: { "date-time": true },
  }).compile(schema);
  const parsed = devDeliveryAuthorityCliOptions([
    "observe",
    "--repository",
    "kungfu-systems/buildchain",
    "--branch",
    "dev/v4/v4.0",
  ]);
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const generatedSchema = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        "dist/site/schemas/dev-delivery-authority-v2.schema.json",
      ),
      "utf8",
    ),
  );
  const caller = reusableWorkflowCall(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        ".github/workflows/buildchain-dev-delivery.yml",
      ),
      "utf8",
    ),
  );
  const template = reusableWorkflowCall(
    fs.readFileSync(
      path.join(repositoryRoot, "templates/native-dev-delivery.yml"),
      "utf8",
    ),
  );
  const autoMergeRuntime = fs.readFileSync(
    path.join(repositoryRoot, "scripts/dev-pr-auto-merge.mjs"),
    "utf8",
  );
  const authorityInputs = [
    "target-branch",
    "expected-pr-number",
    "expected-head-sha",
    "source-workflow-run-id",
    "legacy-active-owner-binding-json",
    "delivery-warrant-mode",
    "handoff-workflow-id",
    "source-workflow-id",
    "assignment-root",
    "initiative-root",
    "source-identity-root",
    "source-patch-root",
    "plan-root",
    "closure-root",
    "dependency-root",
    "toolchain-root",
    "environment-root",
    "affected-paths-json",
    "shard-evidence-roots-json",
    "release-blocker-priority-json",
    "native-proof-json",
    "native-command",
    "native-command-root",
    "native-heartbeat-seconds",
    "delivery-class",
    "delivery-priority",
    "queue-admission-context",
    "active-lease-context",
    "landing-mode",
    "dry-run",
  ];
  const queuedCandidate = {
    targetBranch: "dev/v4/v4.0",
    pullRequestNumber: 418,
    sourceHead: "e".repeat(40),
    sourceWorkflowRunId: 9234,
    assignmentRoot: root("1"),
    initiativeRoot: root("2"),
    sourceIdentityRoot: root("3"),
    sourcePatchRoot: root("4"),
    planRoot: root("5"),
    closureRoot: root("6"),
    dependencyRoot: root("7"),
    toolchainRoot: root("8"),
    environmentRoot: root("9"),
    affectedPaths: ["packages/native"],
    shardEvidenceRoots: [root("a"), root("b")],
    releaseBlockerPriority: { claimRoot: root("c") },
    nativeCommandContract: createNativeCommandContract("native-release"),
    deliveryClass: "release",
    priority: "emergency",
  };
  const mappingNames = [
    "target-branch",
    "expected-pr-number",
    "expected-head-sha",
    "source-workflow-run-id",
    "assignment-root",
    "initiative-root",
    "source-identity-root",
    "source-patch-root",
    "plan-root",
    "closure-root",
    "dependency-root",
    "toolchain-root",
    "environment-root",
    "affected-paths-json",
    "shard-evidence-roots-json",
    "release-blocker-priority-json",
    "native-command",
    "native-command-root",
    "delivery-class",
    "delivery-priority",
    "queue-admission-context",
    "active-lease-context",
  ];
  const expectedMapping = {
    "target-branch": queuedCandidate.targetBranch,
    "expected-pr-number": queuedCandidate.pullRequestNumber,
    "expected-head-sha": queuedCandidate.sourceHead,
    "source-workflow-run-id": queuedCandidate.sourceWorkflowRunId,
    "assignment-root": queuedCandidate.assignmentRoot,
    "initiative-root": queuedCandidate.initiativeRoot,
    "source-identity-root": queuedCandidate.sourceIdentityRoot,
    "source-patch-root": queuedCandidate.sourcePatchRoot,
    "plan-root": queuedCandidate.planRoot,
    "closure-root": queuedCandidate.closureRoot,
    "dependency-root": queuedCandidate.dependencyRoot,
    "toolchain-root": queuedCandidate.toolchainRoot,
    "environment-root": queuedCandidate.environmentRoot,
    "affected-paths-json": JSON.stringify(queuedCandidate.affectedPaths),
    "shard-evidence-roots-json": JSON.stringify(
      queuedCandidate.shardEvidenceRoots,
    ),
    "release-blocker-priority-json": JSON.stringify(
      queuedCandidate.releaseBlockerPriority,
    ),
    "native-command": queuedCandidate.nativeCommandContract.command,
    "native-command-root": queuedCandidate.nativeCommandContract.commandRoot,
    "delivery-class": queuedCandidate.deliveryClass,
    "delivery-priority": queuedCandidate.priority,
    "queue-admission-context": "Queue admission lease",
    "active-lease-context": "Queue family lease/exact",
  };
  const dispatchContext = {
    github: {
      event_name: "repository_dispatch",
      event: { client_payload: { candidate: queuedCandidate }, inputs: {} },
      run_id: 1,
      sha: "f".repeat(40),
    },
    inputs: {},
  };
  const publicAuthority =
    await import("@kungfu-tech/buildchain/dev-delivery-authority");
  prove(
    "DA-15",
    validate(landing.state) === true &&
      parsed.command === "observe" &&
      publicAuthority.admitDevDeliveryMergeGroup ===
        admitDevDeliveryMergeGroup &&
      !("createDevDeliveryLandingTerminalReadback" in publicAuthority) &&
      typeof publicAuthority.settleDevDeliveryAuthorityCandidateWithGitHubProvider ===
        "function" &&
      schema.$defs.landingTerminalReadback.properties.verifier.const ===
        "buildchain-github-provider-live-readback" &&
      schema.$defs.nativeFailureEvidence.properties.schema.const ===
        "kungfu.buildchain.two-phase-delivery-failure/v1" &&
      schema.$defs.providerFailureSettlement.properties.schema.const ===
        "kungfu.buildchain.provider-failure-settlement/v1" &&
      packageManifest.exports["./dev-delivery-authority"] ===
        "./packages/core/dev-delivery-authority-landing.js" &&
      template.uses.endsWith("/dev-pr-auto-merge.yml@v4-alpha") &&
      executeWorkflowMapping(template, dispatchContext, ["buildchain-ref"])[
        "buildchain-ref"
      ] === "v4-alpha" &&
      authorityInputs.every(
        (input) => input in caller.with && input in template.with,
      ) &&
      autoMergeRuntime.includes(
        'activeLeaseContext: String(options.activeLeaseContext || (choiceOption(options.warrantMode, VALID_WARRANT_MODES, "off", "delivery Warrant mode") === "required" ? "Queue family lease/exact" : "")).trim(),',
      ) &&
      JSON.stringify(
        executeWorkflowMapping(caller, dispatchContext, mappingNames),
      ) === JSON.stringify(expectedMapping) &&
      JSON.stringify(
        executeWorkflowMapping(template, dispatchContext, mappingNames),
      ) === JSON.stringify(expectedMapping) &&
      JSON.stringify(generatedSchema) === JSON.stringify(schema),
  );

  assert.deepEqual(
    [...proved].sort(),
    matrix.invariants
      .filter(({ disposition }) => disposition !== "missing-before-closeout")
      .map(({ id }) => id)
      .sort(),
  );
  assert.throws(
    () =>
      closeDevDeliveryWarrant(selected.queue, selected.warrant, {
        outcome: "merged",
        evidenceRoot: root("e"),
        now: "2026-08-15T00:00:30Z",
      }),
    /before native qualification/u,
  );
});
