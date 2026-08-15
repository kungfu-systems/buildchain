import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  createDevDeliveryQueue,
  devDeliveryContentRoot,
  createNativeCommandContract,
  createNativeExecutionReceipt,
  createNativeQualificationProof,
  createSourceQualificationProof,
  selectDevDeliveryWarrant,
  submitDevDeliveryCandidate as submitLegacyDevDeliveryCandidate,
} from "../packages/core/dev-delivery-warrant.js";
import {
  DEV_DELIVERY_AUTHORITY_MODE,
  acquireDevDeliveryLandingWarrant,
  acquireDevDeliveryQualificationLease,
  admitDevDeliveryMergeGroup,
  completeDevDeliveryQualification as completeDevDeliveryQualificationCore,
  createDevDeliveryAuthorityState,
  createDevDeliveryQualificationContract,
  heartbeatDevDeliveryLandingWarrant,
  heartbeatDevDeliveryLandingWarrantWithGitHubProvider,
  readGitHubLandingActiveProviderAttempt,
  readGitHubLandingTerminalState,
  heartbeatDevDeliveryQualificationLease,
  migrateDevDeliveryAuthorityState,
  normalizeDevDeliveryAuthorityState,
  observeDevDeliveryAuthorityState,
  recoverDevDeliveryAuthority,
  settleDevDeliveryAuthorityCandidate,
  settleDevDeliveryAuthorityCandidateWithGitHubProvider,
  submitDevDeliveryAuthorityCandidate,
} from "../packages/core/dev-delivery-authority-landing.js";
import {
  DEV_DELIVERY_TESTING_PROVIDER_READBACK,
  admitDevDeliveryMergeGroupForTesting,
  sealLandingTerminalReadbackForTesting,
} from "../packages/core/dev-delivery-landing-testing-port.js";
import { deriveDevDeliveryLandingProviderAttempt } from "../packages/core/dev-delivery-landing-readback.js";
import {
  defaultDevDeliveryAuthorityStateRef,
  devDeliveryAuthorityCliOptions,
  runDevDeliveryAuthorityCommand,
} from "../scripts/dev-delivery-authority.mjs";

const root = (digit) => `sha256:${digit.repeat(64)}`;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const NATIVE_COMMAND_CONTRACT = createNativeCommandContract("native-shards");
const QUALIFIED_BASE = "e".repeat(40);

function authoritySchemaValidator() {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        "contracts/dev-delivery-authority-v2.schema.json",
      ),
      "utf8",
    ),
  );
  return new Ajv2020({
    strict: false,
    formats: { "date-time": true },
  }).compile(schema);
}

function rerootLegacyState(state) {
  const body = structuredClone(state);
  delete body.stateRoot;
  return { ...body, stateRoot: devDeliveryContentRoot(body) };
}

function candidate(number, overrides = {}) {
  const digit = ((number % 8) + 1).toString(16);
  const input = {
    pullRequestNumber: number,
    sourceHead: digit.repeat(40),
    assignmentRoot: root("1"),
    initiativeRoot: root("2"),
    sourceIdentityRoot: root(digit),
    sourcePatchRoot: root("3"),
    planRoot: root("5"),
    closureRoot: root("6"),
    dependencyRoot: root("7"),
    toolchainRoot: root("8"),
    environmentRoot: root("9"),
    nativeCommandContract: NATIVE_COMMAND_CONTRACT,
    affectedPaths: ["packages/native"],
    shardEvidenceRoots: [root("a")],
    deliveryClass: "native-proof-required",
    qualificationDomains: [root(digit)],
    ...overrides,
  };
  const sourceProof = sourceProofFor(input);
  return { ...input, sourceProofRoot: sourceProof.proofRoot };
}

function providerAttemptFor(sourceHead, mergeGroupHead, overrides = {}) {
  return {
    schema: "kungfu.buildchain.github-landing-provider-attempt/v1",
    repository: "kungfu-systems/kungfu",
    workflowId: 700,
    workflowPath: ".github/workflows/dev-pr-auto-merge.yml",
    workflowRef:
      "kungfu-systems/kungfu/.github/workflows/dev-pr-auto-merge.yml@refs/heads/dev/v4/v4.0",
    workflowSha: "c".repeat(40),
    event: "merge_group",
    runId: 1200,
    runAttempt: 1,
    jobId: 1201,
    jobName: "Landing authority",
    jobRole: "landing-authority",
    runnerId: 1300,
    runnerName: "GitHub Actions 1300",
    runnerGroupId: 1,
    runnerGroupName: "GitHub Actions",
    runnerLabels: ["X64", "ubuntu-24.04"],
    sourceHead,
    mergeGroupHead,
    protectedBase: "dev/v4/v4.0",
    ...overrides,
  };
}

function sourceProofFor(candidateInput) {
  return createSourceQualificationProof({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    sourceIdentityRoot: candidateInput.sourceIdentityRoot,
    sourceHead: candidateInput.sourceHead,
    sourcePatchRoot: candidateInput.sourcePatchRoot,
    planRoot: candidateInput.planRoot,
    closureRoot: candidateInput.closureRoot,
    dependencyRoot: candidateInput.dependencyRoot,
    toolchainRoot: candidateInput.toolchainRoot,
    affectedPaths: candidateInput.affectedPaths,
    shardEvidenceRoots: candidateInput.shardEvidenceRoots,
    qualifiedAt: "2026-08-12T00:00:00Z",
  });
}

function exactQualificationEvidence(state, lease) {
  const candidateState = state.candidates.find(
    (entry) => entry.candidateId === lease.candidateId,
  );
  const sourceProof = sourceProofFor(candidateState);
  const nativeExecutionReceipt = createNativeExecutionReceipt({
    outcome: "succeeded",
    commandRoot: candidateState.nativeCommandContract.commandRoot,
    executionBinding: {
      repository: state.repository,
      protectedBase: state.protectedBase,
      sourceHead: candidateState.sourceHead,
      qualifiedBase: QUALIFIED_BASE,
      nativeCommandRoot: candidateState.nativeCommandContract.commandRoot,
      toolchainRoot: candidateState.toolchainRoot,
      environmentRoot: candidateState.environmentRoot,
    },
    startedAt: "2026-08-12T00:00:01Z",
    completedAt: "2026-08-12T00:00:02Z",
    heartbeatCount: 2,
  });
  const nativeProof = createNativeQualificationProof({
    repository: state.repository,
    protectedBase: state.protectedBase,
    sourceIdentityRoot: candidateState.sourceIdentityRoot,
    sourcePatchRoot: candidateState.sourcePatchRoot,
    planRoot: candidateState.planRoot,
    closureRoot: candidateState.closureRoot,
    dependencyRoot: candidateState.dependencyRoot,
    toolchainRoot: candidateState.toolchainRoot,
    environmentRoot: candidateState.environmentRoot,
    nativeCommandRoot: candidateState.nativeCommandContract.commandRoot,
    sourceHead: candidateState.sourceHead,
    qualifiedBase: QUALIFIED_BASE,
    nativeExecutionReceipt,
    affectedPaths: candidateState.affectedPaths,
    shardEvidenceRoots: candidateState.shardEvidenceRoots,
    qualifiedAt: "2026-08-12T00:00:03Z",
  });
  const qualificationContract = createDevDeliveryQualificationContract({
    state,
    candidate: candidateState,
    lease,
    sourceProof,
    nativeProof,
  });
  return { sourceProof, nativeProof, qualificationContract };
}

function completeDevDeliveryQualification(state, lease, { now } = {}) {
  return completeDevDeliveryQualificationCore(state, lease, {
    ...exactQualificationEvidence(state, lease),
    now,
  });
}

function authorityState(policy = {}) {
  return createDevDeliveryAuthorityState({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    policy: {
      maxQualificationLeases: 2,
      qualificationLeaseSeconds: 600,
      landingLeaseSeconds: 300,
      ...policy,
    },
    now: "2026-08-12T00:00:00Z",
  });
}

test("single-flight v1 bytes remain the default when bounded authority is off", () => {
  const legacy = createDevDeliveryQueue({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    policy: { agingSeconds: 300, leaseSeconds: 600 },
    now: "2026-08-04T00:00:00Z",
  });

  assert.equal(
    JSON.stringify(legacy),
    '{"schemaVersion":1,"contract":"kungfu-buildchain-dev-delivery-warrant-queue","repository":"kungfu-systems/kungfu","protectedBase":"dev/v4/v4.0","generation":0,"fencingCounter":0,"policy":{"agingSeconds":300,"maxPriority":2,"leaseSeconds":600,"emergencyPolicy":"reviewed-explicit-only"},"activeWarrant":null,"candidates":[],"updatedAt":"2026-08-04T00:00:00.000Z","stateRoot":"sha256:5de99c1862e228278e13f954c5f420d9a3e1e182ee80882196c664b297f28754"}',
  );
  assert.equal(Object.hasOwn(legacy, "authorityMode"), false);
});

test("public Delivery Authority Node API owns live readback and merge-group admission", async () => {
  const publicAuthority =
    await import("@kungfu-tech/buildchain/dev-delivery-authority");
  for (const name of [
    "DEV_DELIVERY_LANDING_TERMINAL_READBACK_SCHEMA",
    "readGitHubLandingActiveProviderAttempt",
    "readGitHubLandingTerminalState",
    "verifyExpiredLandingSettlementReadback",
  ]) {
    assert.equal(
      Object.hasOwn(publicAuthority, name),
      true,
      `${name} must be a declared public Node API`,
    );
  }
  assert.equal(
    Object.hasOwn(publicAuthority, "sealLandingTerminalReadbackForTesting"),
    false,
  );

  const submitted = submitDevDeliveryAuthorityCandidate(
    authorityState(),
    candidate(98),
    { now: "2026-08-12T00:00:01Z" },
  );
  const leased = acquireDevDeliveryQualificationLease(submitted.state, {
    now: "2026-08-12T00:00:02Z",
  });
  const qualified = completeDevDeliveryQualification(
    leased.state,
    leased.lease,
    { evidenceRoot: root("9"), now: "2026-08-12T00:00:03Z" },
  );
  const landing = acquireDevDeliveryLandingWarrant(qualified.state, {
    now: "2026-08-12T00:00:04Z",
  });
  await assert.rejects(
    publicAuthority.admitDevDeliveryMergeGroup(landing.state, landing.warrant, {
      mergeGroupHead: "b".repeat(40),
      providerAttempt: providerAttemptFor(
        qualified.state.candidates[0].sourceHead,
        "b".repeat(40),
      ),
      now: "2026-08-12T00:00:05Z",
    }),
    /GitHub provider run id must be a positive integer/u,
  );
});

test("machine-readable v2 schema accepts the normalized authority state", () => {
  const validate = authoritySchemaValidator();
  assert.equal(
    validate(authorityState()),
    true,
    JSON.stringify(validate.errors),
  );

  const invalid = authorityState();
  invalid.qualificationLeases.push({
    schema: "kungfu.buildchain.dev-delivery-qualification-lease/v1",
    authority: "qualification-only",
    mergeGroupAdmission: true,
    candidateId: root("1"),
    token: root("2"),
    generation: 1,
    issuedAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2026-08-12T00:10:00.000Z",
  });
  assert.equal(validate(invalid), false);
});

test("an active provisional v1 Warrant migrates without rewriting evidence or granting landing", () => {
  const legacy = createDevDeliveryQueue({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v3/v3.0",
    now: "2026-08-12T00:00:00Z",
  });
  const submitted = submitLegacyDevDeliveryCandidate(legacy, candidate(90), {
    now: "2026-08-12T00:00:01Z",
  });
  const selected = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-12T00:00:02Z",
  });
  const migrated = migrateDevDeliveryAuthorityState(selected.queue, {
    now: "2026-08-12T00:00:03Z",
  });

  assert.equal(migrated.receipt.legacyStateRoot, selected.queue.stateRoot);
  assert.equal(migrated.receipt.activeAuthority, "qualification-lease");
  assert.equal(
    migrated.state.migration.legacyStateRoot,
    selected.queue.stateRoot,
  );
  assert.equal(migrated.state.landingWarrant, null);
  assert.equal(migrated.state.qualificationLeases.length, 1);
  assert.equal(
    migrated.state.qualificationLeases[0].token,
    selected.warrant.fencingToken,
  );
  assert.equal(
    migrated.state.qualificationLeases[0].generation,
    selected.warrant.generation,
  );
  assert.equal(
    migrated.state.qualificationLeases[0].mergeGroupAdmission,
    false,
  );
  assert.throws(
    () =>
      admitDevDeliveryMergeGroupForTesting(
        migrated.state,
        migrated.state.qualificationLeases[0],
        { mergeGroupHead: "a".repeat(40), now: "2026-08-12T00:00:04Z" },
      ),
    /Qualification Lease cannot admit merge_group/,
  );
});

test("historical phase-less active Warrant migrates with schema-safe compatibility state", () => {
  const legacy = createDevDeliveryQueue({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v3/v3.0",
    now: "2026-08-12T00:05:00Z",
  });
  const historical = candidate(91, {
    environmentRoot: undefined,
    deliveryClass: "non-native-fast",
  });
  const submitted = submitLegacyDevDeliveryCandidate(legacy, historical, {
    now: "2026-08-12T00:05:01Z",
  });
  const selected = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-12T00:05:02Z",
  });
  assert.equal(Object.hasOwn(selected.warrant, "phase"), false);
  assert.equal(
    selectDevDeliveryWarrant(selected.queue, {
      now: "2026-08-12T00:05:03Z",
    }).receipt.reason,
    "non-preemptive-active-warrant",
  );

  const migrated = migrateDevDeliveryAuthorityState(selected.queue, {
    now: "2026-08-12T00:05:04Z",
  });
  assert.equal(migrated.receipt.activeAuthority, "landing-warrant");
  assert.equal(migrated.state.qualificationLeases.length, 0);
  assert.equal(
    migrated.state.landingWarrant.token,
    selected.warrant.fencingToken,
  );
  assert.deepEqual(migrated.state.candidates[0].qualification, {
    schema: "kungfu.buildchain.dev-delivery-compatibility-qualification/v1",
    authority: "legacy-compatibility-only",
    nativeProofAuthority: false,
    legacyStateRoot: selected.queue.stateRoot,
    legacyWarrantPhase: "phase-less",
    legacyFencingToken: selected.warrant.fencingToken,
    legacyGeneration: selected.warrant.generation,
    qualificationReceiptRoot: null,
    sourceProofRoot: historical.sourceProofRoot,
    nativeProofRoot: null,
    nativeExecutionBindingRoot: null,
    nativeExecutionReceiptRoot: null,
    nativeCommandRoot: null,
    qualificationContractRoot: null,
    qualifiedAt: null,
  });
  const validate = authoritySchemaValidator();
  assert.equal(validate(migrated.state), true, JSON.stringify(validate.errors));
});

test("qualified v1 Warrant migration remains schema-valid without claiming v2 native proof", () => {
  const legacy = createDevDeliveryQueue({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v3/v3.0",
    now: "2026-08-12T00:06:00Z",
  });
  const submitted = submitLegacyDevDeliveryCandidate(legacy, candidate(92), {
    now: "2026-08-12T00:06:01Z",
  });
  const selected = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-12T00:06:02Z",
  });
  const qualifiedLegacy = structuredClone(selected.queue);
  qualifiedLegacy.activeWarrant.phase = "qualified";
  qualifiedLegacy.activeWarrant.nativeProofRoot = root("b");
  qualifiedLegacy.activeWarrant.nativeProofReuseRoot = root("c");
  qualifiedLegacy.activeWarrant.nativeExecutionReceiptRoot = root("d");
  qualifiedLegacy.activeWarrant.qualificationReceiptRoot = root("e");
  qualifiedLegacy.activeWarrant.qualifiedAt = "2026-08-12T00:06:03.000Z";
  qualifiedLegacy.candidates[0].status = "qualified";
  qualifiedLegacy.candidates[0].updatedAt = "2026-08-12T00:06:03.000Z";

  const migrated = migrateDevDeliveryAuthorityState(
    rerootLegacyState(qualifiedLegacy),
    { now: "2026-08-12T00:06:04Z" },
  );
  const qualification = migrated.state.candidates[0].qualification;
  assert.equal(qualification.authority, "legacy-compatibility-only");
  assert.equal(qualification.nativeProofAuthority, false);
  assert.equal(qualification.legacyWarrantPhase, "qualified");
  assert.equal(qualification.nativeProofRoot, root("b"));
  assert.equal(qualification.nativeExecutionBindingRoot, null);
  assert.equal(qualification.qualificationContractRoot, null);
  const validate = authoritySchemaValidator();
  assert.equal(validate(migrated.state), true, JSON.stringify(validate.errors));

  const compatibilityOnly = structuredClone(migrated.state);
  compatibilityOnly.landingWarrant = null;
  compatibilityOnly.candidates[0].status = "qualified";
  const honestCompatibilityState = normalizeDevDeliveryAuthorityState(
    rerootLegacyState(compatibilityOnly),
  );
  const refused = acquireDevDeliveryLandingWarrant(honestCompatibilityState, {
    now: "2026-08-12T00:06:05Z",
  });
  assert.equal(refused.warrant, null);
  assert.equal(
    refused.receipt.blockedReason.code,
    "native-qualification-authority-required",
  );
});

test("v2 normalization rejects partial or unmarked native qualification objects", () => {
  const input = candidate(93);
  const submitted = submitDevDeliveryAuthorityCandidate(
    authorityState(),
    input,
    { now: "2026-08-12T00:07:01Z" },
  );
  const leased = acquireDevDeliveryQualificationLease(submitted.state, {
    now: "2026-08-12T00:07:02Z",
  });
  const qualified = completeDevDeliveryQualification(
    leased.state,
    leased.lease,
    { now: "2026-08-12T00:07:03Z" },
  );
  assert.equal(
    qualified.state.candidates[0].qualification.authority,
    "verified-native-qualification",
  );
  for (const field of [
    "schema",
    "authority",
    "nativeProofAuthority",
    "qualificationReceiptRoot",
    "sourceProofRoot",
    "nativeProofRoot",
    "nativeExecutionBindingRoot",
    "nativeExecutionReceiptRoot",
    "nativeCommandRoot",
    "qualificationContractRoot",
  ]) {
    const partial = structuredClone(qualified.state);
    delete partial.candidates[0].qualification[field];
    assert.throws(
      () => normalizeDevDeliveryAuthorityState(rerootLegacyState(partial)),
      /qualification|proof authority|sha256 content root/u,
      field,
    );
  }
  const timestampOnly = structuredClone(qualified.state);
  timestampOnly.candidates[0].qualification = {
    qualifiedAt: "2026-08-12T00:07:03Z",
  };
  assert.throws(
    () => normalizeDevDeliveryAuthorityState(rerootLegacyState(timestampOnly)),
    /native qualification schema is unsupported/u,
  );
});

test("bounded Qualification Leases cannot admit merge_group and Landing remains exclusive", () => {
  const first = submitDevDeliveryAuthorityCandidate(
    authorityState(),
    candidate(100),
    { now: "2026-08-12T00:00:01Z" },
  );
  const second = submitDevDeliveryAuthorityCandidate(
    first.state,
    candidate(101),
    { now: "2026-08-12T00:00:02Z" },
  );
  const leasedFirst = acquireDevDeliveryQualificationLease(second.state, {
    now: "2026-08-12T00:00:03Z",
  });
  const leasedSecond = acquireDevDeliveryQualificationLease(leasedFirst.state, {
    now: "2026-08-12T00:00:04Z",
  });

  assert.equal(leasedSecond.state.qualificationLeases.length, 2);
  assert.equal(leasedSecond.lease.mergeGroupAdmission, false);

  const qualifiedFirst = completeDevDeliveryQualification(
    leasedSecond.state,
    leasedFirst.lease,
    { evidenceRoot: root("9"), now: "2026-08-12T00:00:05Z" },
  );
  const landingFirst = acquireDevDeliveryLandingWarrant(qualifiedFirst.state, {
    now: "2026-08-12T00:00:06Z",
  });

  assert.throws(
    () =>
      admitDevDeliveryMergeGroupForTesting(
        landingFirst.state,
        leasedSecond.lease,
        {
          mergeGroupHead: "a".repeat(40),
          now: "2026-08-12T00:00:07Z",
        },
      ),
    /Qualification Lease cannot admit merge_group/,
  );

  const qualifiedSecond = completeDevDeliveryQualification(
    landingFirst.state,
    leasedSecond.lease,
    { evidenceRoot: root("a"), now: "2026-08-12T00:00:08Z" },
  );
  const retained = acquireDevDeliveryLandingWarrant(qualifiedSecond.state, {
    now: "2026-08-12T00:00:09Z",
  });

  assert.equal(
    retained.receipt.action,
    "exclusive-landing-warrant-retained-noop",
  );

  const duplicateController = acquireDevDeliveryLandingWarrant(
    qualifiedSecond.state,
    { now: "2026-08-12T00:00:09Z" },
  );
  assert.equal(duplicateController.state.stateRoot, retained.state.stateRoot);
  assert.equal(duplicateController.warrant.token, retained.warrant.token);
  assert.equal(retained.warrant.candidateId, landingFirst.warrant.candidateId);
  assert.equal(retained.state.stateRoot, qualifiedSecond.state.stateRoot);
  assert.equal(
    retained.state.candidates.filter((entry) => entry.status === "landing")
      .length,
    1,
  );

  const admission = admitDevDeliveryMergeGroupForTesting(
    retained.state,
    retained.warrant,
    {
      mergeGroupHead: "b".repeat(40),
      providerAttempt: providerAttemptFor(
        qualifiedFirst.state.candidates[0].sourceHead,
        "b".repeat(40),
      ),
      now: "2026-08-12T00:00:10Z",
    },
  );
  assert.equal(admission.admission.authority, "exclusive-landing-warrant");
  assert.equal(
    admission.admission.candidateId,
    landingFirst.warrant.candidateId,
  );

  const drifted = structuredClone(retained.state);
  drifted.landingWarrant = {
    ...drifted.landingWarrant,
    candidateId: qualifiedSecond.state.candidates[1].candidateId,
  };
  delete drifted.stateRoot;
  assert.throws(
    () => normalizeDevDeliveryAuthorityState(drifted),
    /exclusive Landing Warrant must match one landing candidate/,
  );
});

test("bounded qualification rejects arbitrary roots and Landing atomically binds one merge-group head", () => {
  const input = candidate(209);
  const submitted = submitDevDeliveryAuthorityCandidate(
    authorityState(),
    input,
    { now: "2026-08-12T00:05:01Z" },
  );
  const leased = acquireDevDeliveryQualificationLease(submitted.state, {
    now: "2026-08-12T00:05:02Z",
  });
  assert.throws(
    () =>
      completeDevDeliveryQualificationCore(leased.state, leased.lease, {
        evidenceRoot: root("f"),
        now: "2026-08-12T00:05:03Z",
      }),
    /source qualification proof rejected/u,
  );
  const evidence = exactQualificationEvidence(leased.state, leased.lease);
  const differentCommand = createNativeCommandContract("native-smoke-only");
  const driftedReceipt = createNativeExecutionReceipt({
    outcome: "succeeded",
    commandRoot: differentCommand.commandRoot,
    executionBinding: {
      ...evidence.nativeProof.nativeExecutionReceipt.executionBinding,
      nativeCommandRoot: differentCommand.commandRoot,
    },
    startedAt: "2026-08-12T00:00:01Z",
    completedAt: "2026-08-12T00:00:02Z",
    heartbeatCount: 2,
  });
  const driftedProof = createNativeQualificationProof({
    ...evidence.nativeProof,
    nativeCommandRoot: differentCommand.commandRoot,
    nativeExecutionReceipt: driftedReceipt,
  });
  assert.throws(
    () =>
      completeDevDeliveryQualificationCore(leased.state, leased.lease, {
        ...evidence,
        nativeProof: driftedProof,
        now: "2026-08-12T00:05:03Z",
      }),
    /nativeCommandRoot-mismatch/u,
  );
  const qualified = completeDevDeliveryQualificationCore(
    leased.state,
    leased.lease,
    { ...evidence, now: "2026-08-12T00:05:03Z" },
  );
  assert.equal(
    qualified.state.candidates[0].qualification.qualificationReceiptRoot,
    qualified.receiptRoot,
  );
  const landing = acquireDevDeliveryLandingWarrant(qualified.state, {
    now: "2026-08-12T00:05:04Z",
  });
  const admitted = admitDevDeliveryMergeGroupForTesting(
    landing.state,
    landing.warrant,
    {
      mergeGroupHead: "a".repeat(40),
      providerAttempt: providerAttemptFor(
        qualified.state.candidates[0].sourceHead,
        "a".repeat(40),
      ),
      now: "2026-08-12T00:05:05Z",
    },
  );
  assert.equal(admitted.state.landingWarrant.mergeGroupHead, "a".repeat(40));
  assert.equal(
    admitted.state.landingWarrant.mergeGroupAdmissionRoot,
    admitted.admissionRoot,
  );
  const duplicate = admitDevDeliveryMergeGroupForTesting(
    admitted.state,
    admitted.state.landingWarrant,
    {
      mergeGroupHead: "a".repeat(40),
      providerAttempt: admitted.state.landingWarrant.providerAttempt,
      now: "2026-08-12T00:05:06Z",
    },
  );
  assert.equal(duplicate.state.stateRoot, admitted.state.stateRoot);
  assert.equal(duplicate.admissionRoot, admitted.admissionRoot);
  assert.throws(
    () =>
      admitDevDeliveryMergeGroupForTesting(
        admitted.state,
        admitted.state.landingWarrant,
        {
          mergeGroupHead: "b".repeat(40),
          providerAttempt: providerAttemptFor(
            admitted.state.candidates[0].sourceHead,
            "b".repeat(40),
          ),
          now: "2026-08-12T00:05:06Z",
        },
      ),
    /already admitted a different merge-group head/u,
  );
});

test("stale qualification and Landing fencing fail closed", () => {
  const submitted = submitDevDeliveryAuthorityCandidate(
    authorityState(),
    candidate(150),
    { now: "2026-08-12T00:10:01Z" },
  );
  const leased = acquireDevDeliveryQualificationLease(submitted.state, {
    now: "2026-08-12T00:10:02Z",
  });
  assert.throws(
    () =>
      completeDevDeliveryQualification(
        leased.state,
        { ...leased.lease, generation: leased.lease.generation + 1 },
        { evidenceRoot: root("9"), now: "2026-08-12T00:10:03Z" },
      ),
    /stale qualification lease generation/,
  );
  const qualified = completeDevDeliveryQualification(
    leased.state,
    leased.lease,
    { evidenceRoot: root("9"), now: "2026-08-12T00:10:03Z" },
  );
  const landing = acquireDevDeliveryLandingWarrant(qualified.state, {
    now: "2026-08-12T00:10:04Z",
  });
  assert.throws(
    () =>
      admitDevDeliveryMergeGroupForTesting(
        landing.state,
        { ...landing.warrant, token: root("f") },
        { mergeGroupHead: "b".repeat(40), now: "2026-08-12T00:10:05Z" },
      ),
    /stale Landing Warrant token/,
  );
});

test("proof drift and merge settlement without Landing authority fail closed", () => {
  const submitted = submitDevDeliveryAuthorityCandidate(
    authorityState(),
    candidate(175),
    {
      now: "2026-08-12T00:20:01Z",
    },
  );
  assert.throws(
    () =>
      submitDevDeliveryAuthorityCandidate(
        submitted.state,
        { ...candidate(175), toolchainRoot: root("f") },
        { now: "2026-08-12T00:20:02Z" },
      ),
    /different active authority state/,
  );
  assert.throws(
    () =>
      submitDevDeliveryAuthorityCandidate(
        submitted.state,
        { ...candidate(175), environmentRoot: root("e") },
        { now: "2026-08-12T00:20:02Z" },
      ),
    /different active authority state/,
  );
  assert.throws(
    () =>
      submitDevDeliveryAuthorityCandidate(
        authorityState(),
        { ...candidate(176), environmentRoot: undefined },
        { now: "2026-08-12T00:20:02Z" },
      ),
    /environmentRoot/u,
  );
  assert.throws(
    () =>
      settleDevDeliveryAuthorityCandidate(
        submitted.state,
        {
          pullRequestNumber: 175,
          sourceHead: candidate(175).sourceHead,
          outcome: "merged",
          evidenceRoot: root("e"),
        },
        { now: "2026-08-12T00:20:03Z" },
      ),
    /merged settlement requires the exact active Landing Warrant/,
  );

  const corrupted = structuredClone(submitted.state);
  corrupted.candidates[0].status = "landing";
  corrupted.landingWarrant = {
    schema: "kungfu.buildchain.dev-delivery-landing-warrant/v1",
    authority: "merge-group-admission",
    mergeGroupAdmission: true,
    candidateId: corrupted.candidates[0].candidateId,
    token: root("d"),
    generation: 1,
    issuedAt: "2026-08-12T00:20:01.000Z",
    expiresAt: "2026-08-12T00:30:01.000Z",
  };
  delete corrupted.stateRoot;
  assert.throws(
    () => normalizeDevDeliveryAuthorityState(corrupted),
    /qualified or landing candidate requires qualification evidence/,
  );
});

test("expired Landing authority is retained until exact provider stop or terminal settlement", () => {
  const input = candidate(180);
  const submitted = submitDevDeliveryAuthorityCandidate(
    authorityState({ landingLeaseSeconds: 10 }),
    input,
    {
      now: "2026-08-12T00:30:01Z",
    },
  );
  const leased = acquireDevDeliveryQualificationLease(submitted.state, {
    now: "2026-08-12T00:30:02Z",
  });
  const qualified = completeDevDeliveryQualification(
    leased.state,
    leased.lease,
    {
      evidenceRoot: root("a"),
      now: "2026-08-12T00:30:03Z",
    },
  );
  const landing = acquireDevDeliveryLandingWarrant(qualified.state, {
    now: "2026-08-12T00:30:04Z",
    leaseSeconds: 10,
  });
  const admitted = admitDevDeliveryMergeGroupForTesting(
    landing.state,
    landing.warrant,
    {
      mergeGroupHead: "d".repeat(40),
      providerAttempt: providerAttemptFor(input.sourceHead, "d".repeat(40)),
      now: "2026-08-12T00:30:05Z",
    },
  );

  const recovered = recoverDevDeliveryAuthority(admitted.state, {
    now: "2026-08-12T00:30:15Z",
  });
  assert.equal(
    recovered.receipt.action,
    "expired-landing-warrant-stop-required-noop",
  );
  assert.equal(recovered.state.stateRoot, admitted.state.stateRoot);
  assert.equal(recovered.state.landingWarrant.token, landing.warrant.token);
  assert.equal(recovered.wake.landingCandidateId, null);

  const blocked = acquireDevDeliveryLandingWarrant(recovered.state, {
    now: "2026-08-12T00:30:16Z",
  });
  assert.equal(blocked.warrant, null);
  assert.equal(
    blocked.receipt.action,
    "expired-landing-warrant-stop-required-noop",
  );
  assert.equal(blocked.state.stateRoot, admitted.state.stateRoot);

  const settlement = {
    pullRequestNumber: input.pullRequestNumber,
    sourceHead: input.sourceHead,
    outcome: "terminal-failure",
    evidenceRoot: root("f"),
    authorityToken: landing.warrant.token,
    authorityGeneration: landing.warrant.generation,
    reason: "caller-asserted-stop",
    transferRoot: root("b"),
    finalizerBoundaryRoot: root("c"),
    nativeJobId: 2201,
    sealJobId: 2202,
  };
  assert.throws(
    () =>
      settleDevDeliveryAuthorityCandidate(blocked.state, settlement, {
        now: "2026-08-12T00:30:17Z",
      }),
    /product-owned GitHub live readback/u,
  );
  const validReadback = sealLandingTerminalReadbackForTesting({
    repository: blocked.state.repository,
    protectedBase: blocked.state.protectedBase,
    stateRoot: blocked.state.stateRoot,
    candidateId: blocked.state.candidates[0].candidateId,
    pullRequestNumber: input.pullRequestNumber,
    sourceHead: input.sourceHead,
    landingWarrantToken: landing.warrant.token,
    landingWarrantGeneration: landing.warrant.generation,
    providerRunId: admitted.state.landingWarrant.providerAttempt.runId,
    providerRunAttempt: 1,
    providerRunState: "completed",
    providerRunConclusion: "failure",
    providerRunHead: admitted.state.landingWarrant.mergeGroupHead,
    providerJobId: admitted.state.landingWarrant.providerAttempt.jobId,
    providerJobState: "completed",
    providerJobConclusion: "failure",
    providerJobStartedAt: "2026-08-12T00:30:05Z",
    providerJobCompletedAt: "2026-08-12T00:30:15Z",
    providerAttempt: admitted.state.landingWarrant.providerAttempt,
    admissionRoot: admitted.admissionRoot,
    pullRequestState: "open",
    pullRequestMerged: false,
    protectedBaseHead: "e".repeat(40),
    providerRunHeadInProtectedBase: false,
    outcome: "terminal-failure",
    reason: "independent-provider-stop-readback",
    observedAt: "2026-08-12T00:30:16Z",
  });
  for (const [field, value, message] of [
    ["repository", "invalid", /repository must be owner\/repo/u],
    ["protectedBase", "main", /protectedBase must be dev\/vN\/vN\.M/u],
    [
      "pullRequestNumber",
      "209",
      /provider readback pull request must be an integer/u,
    ],
    ["providerRunState", "in_progress", /provider run state is unsupported/u],
    ["providerRunConclusion", null, /provider run conclusion is required/u],
    ["providerJobState", "in_progress", /provider job state is unsupported/u],
    [
      "providerJobConclusion",
      "neutral",
      /provider job conclusion is unsupported/u,
    ],
    [
      "pullRequestState",
      "merged",
      /provider pull request state is unsupported/u,
    ],
    [
      "pullRequestMerged",
      "false",
      /provider pull request merged must be a boolean/u,
    ],
    [
      "providerRunHeadInProtectedBase",
      "false",
      /provider run head in protected base must be a boolean/u,
    ],
    ["outcome", "neutral", /provider outcome is unsupported/u],
  ]) {
    assert.throws(
      () =>
        sealLandingTerminalReadbackForTesting({
          ...validReadback,
          [field]: value,
        }),
      message,
    );
  }
  const mergedReadback = sealLandingTerminalReadbackForTesting({
    ...validReadback,
    providerRunConclusion: "success",
    providerJobConclusion: "success",
    pullRequestState: "closed",
    pullRequestMerged: true,
    protectedBaseHead: admitted.state.landingWarrant.mergeGroupHead,
    providerRunHeadInProtectedBase: true,
    outcome: "merged",
  });
  assert.equal(mergedReadback.outcome, "merged");
  assert.throws(
    () =>
      sealLandingTerminalReadbackForTesting({
        ...mergedReadback,
        providerRunHeadInProtectedBase: false,
      }),
    /exact admitted run head in the protected base/u,
  );
  const forgedRoot = { ...validReadback, readbackRoot: root("e") };
  assert.throws(
    () =>
      settleDevDeliveryAuthorityCandidate(blocked.state, settlement, {
        now: "2026-08-12T00:30:17Z",
        [DEV_DELIVERY_TESTING_PROVIDER_READBACK]: forgedRoot,
      }),
    /product-owned GitHub live readback/u,
  );
  for (const [field, value, message] of [
    ["landingWarrantToken", root("d"), /fence mismatch/u],
    ["landingWarrantGeneration", 99, /generation mismatch/u],
    ["sourceHead", "f".repeat(40), /source head mismatch/u],
    ["providerRunId", 1199, /provider run mismatch/u],
    ["observedAt", "2026-08-12T00:30:03Z", /stale/u],
  ]) {
    const readback = sealLandingTerminalReadbackForTesting({
      ...validReadback,
      [field]: value,
    });
    assert.throws(
      () =>
        settleDevDeliveryAuthorityCandidate(blocked.state, settlement, {
          now: "2026-08-12T00:30:17Z",
          [DEV_DELIVERY_TESTING_PROVIDER_READBACK]: readback,
        }),
      message,
    );
  }
  const settled = settleDevDeliveryAuthorityCandidate(
    blocked.state,
    settlement,
    {
      now: "2026-08-12T00:30:17Z",
      [DEV_DELIVERY_TESTING_PROVIDER_READBACK]: validReadback,
    },
  );
  assert.equal(settled.state.landingWarrant, null);
  assert.equal(settled.receipt.releasedAuthority.kind, "landing-warrant");
  assert.equal(settled.receipt.evidenceRoot, validReadback.evidenceRoot);
  assert.equal(
    settled.receipt.providerTerminalReadbackRoot,
    validReadback.readbackRoot,
  );
  const normalized = normalizeDevDeliveryAuthorityState(
    JSON.parse(JSON.stringify(settled.state)),
  );
  assert.equal(normalized.stateRoot, settled.state.stateRoot);
  assert.deepEqual(
    normalized.candidates[0].terminal.providerAttempt,
    admitted.state.landingWarrant.providerAttempt,
  );
  assert.equal(
    normalized.candidates[0].terminal.providerTerminalReadbackRoot,
    validReadback.readbackRoot,
  );
  assert.deepEqual(
    {
      transferRoot: normalized.candidates[0].terminal.transferRoot,
      finalizerBoundaryRoot:
        normalized.candidates[0].terminal.finalizerBoundaryRoot,
      nativeJobId: normalized.candidates[0].terminal.nativeJobId,
      sealJobId: normalized.candidates[0].terminal.sealJobId,
    },
    {
      transferRoot: settlement.transferRoot,
      finalizerBoundaryRoot: settlement.finalizerBoundaryRoot,
      nativeJobId: settlement.nativeJobId,
      sealJobId: settlement.sealJobId,
    },
  );
  assert.equal(
    observeDevDeliveryAuthorityState(normalized, {
      now: "2026-08-12T00:30:18Z",
    }).stateRoot,
    settled.state.stateRoot,
  );
  const repeated = settleDevDeliveryAuthorityCandidate(
    normalized,
    {
      ...settlement,
      evidenceRoot: validReadback.evidenceRoot,
    },
    { now: "2026-08-12T00:30:19Z" },
  );
  assert.equal(repeated.receipt.action, "duplicate-terminal-event-noop");
  assert.equal(repeated.state.stateRoot, settled.state.stateRoot);
});

test("Landing heartbeat requires the persisted admitted provider attempt and fresh active readback", async () => {
  const input = candidate(181);
  const submitted = submitDevDeliveryAuthorityCandidate(
    authorityState({ landingLeaseSeconds: 10 }),
    input,
    { now: "2026-08-12T00:35:01Z" },
  );
  const leased = acquireDevDeliveryQualificationLease(submitted.state, {
    now: "2026-08-12T00:35:02Z",
  });
  const qualified = completeDevDeliveryQualification(
    leased.state,
    leased.lease,
    { now: "2026-08-12T00:35:03Z" },
  );
  const landing = acquireDevDeliveryLandingWarrant(qualified.state, {
    now: "2026-08-12T00:35:04Z",
    leaseSeconds: 10,
  });
  const providerAttempt = providerAttemptFor(input.sourceHead, "d".repeat(40));
  const admitted = admitDevDeliveryMergeGroupForTesting(
    landing.state,
    landing.warrant,
    {
      mergeGroupHead: "d".repeat(40),
      providerAttempt,
      now: "2026-08-12T00:35:05Z",
    },
  );

  await assert.rejects(
    heartbeatDevDeliveryLandingWarrant(
      admitted.state,
      admitted.state.landingWarrant,
      { now: "2026-08-12T00:35:06Z", leaseSeconds: 10 },
    ),
    /persisted admitted provider attempt/u,
  );
  await assert.rejects(
    heartbeatDevDeliveryLandingWarrant(
      admitted.state,
      admitted.state.landingWarrant,
      {
        now: "2026-08-12T00:35:06Z",
        leaseSeconds: 10,
        providerAttempt: { ...providerAttempt, runAttempt: 2 },
      },
    ),
    /does not match persisted admission/u,
  );

  const providerBodies = {
    "/repos/kungfu-systems/kungfu/actions/runs/1200/attempts/1": {
      id: 1200,
      workflow_id: 700,
      run_attempt: 1,
      event: "merge_group",
      head_sha: "d".repeat(40),
      repository: { full_name: "kungfu-systems/kungfu" },
      status: "in_progress",
      conclusion: null,
      referenced_workflows: [
        {
          path: "kungfu-systems/buildchain/.github/workflows/dev-pr-auto-merge.yml@v4-alpha",
          sha: providerAttempt.workflowSha,
          ref: "refs/tags/v4-alpha",
        },
      ],
    },
    "/repos/kungfu-systems/kungfu/actions/jobs/1201": {
      id: 1201,
      name: "Landing authority",
      status: "in_progress",
      conclusion: null,
      runner_id: 1300,
      runner_name: "GitHub Actions 1300",
      runner_group_id: 1,
      runner_group_name: "GitHub Actions",
      labels: ["ubuntu-24.04", "X64"],
      run_url:
        "https://api.github.com/repos/kungfu-systems/kungfu/actions/runs/1200",
      started_at: "2026-08-12T00:35:05Z",
    },
    "/repos/kungfu-systems/kungfu/pulls/181": {
      number: 181,
      state: "open",
      head: { sha: input.sourceHead },
      base: {
        ref: "dev/v4/v4.0",
        repo: { full_name: "kungfu-systems/kungfu" },
      },
    },
    "/repos/kungfu-systems/kungfu/actions/workflows/700": {
      id: 700,
      path: ".github/workflows/dev-pr-auto-merge.yml",
    },
  };
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    return {
      ok: Boolean(providerBodies[pathname]),
      status: providerBodies[pathname] ? 200 : 404,
      text: async () =>
        JSON.stringify(providerBodies[pathname] || { message: "missing" }),
    };
  };
  assert.deepEqual(
    await readGitHubLandingActiveProviderAttempt({
      state: admitted.state,
      candidate: admitted.state.candidates[0],
      warrant: admitted.state.landingWarrant,
      providerAttempt,
      token: "test-token",
      now: "2026-08-12T00:35:06Z",
      fetchImpl,
    }),
    providerAttempt,
  );
  const server = http.createServer((request, response) => {
    const body = providerBodies[request.url];
    response.setHeader("content-type", "application/json");
    response.statusCode = body ? 200 : 404;
    response.end(JSON.stringify(body || { message: "missing" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const renewed = await heartbeatDevDeliveryLandingWarrant(
      admitted.state,
      admitted.state.landingWarrant,
      {
        providerAttempt,
        token: "test-token",
        apiUrl: `http://127.0.0.1:${address.port}`,
        now: "2026-08-12T00:35:06Z",
        leaseSeconds: 10,
      },
    );
    assert.equal(renewed.receipt.action, "landing-heartbeat");
    assert.equal(renewed.warrant.heartbeatAt, "2026-08-12T00:35:06.000Z");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  providerBodies["/repos/kungfu-systems/kungfu/actions/jobs/1201"].status =
    "completed";
  providerBodies["/repos/kungfu-systems/kungfu/actions/jobs/1201"].conclusion =
    "success";
  await assert.rejects(
    readGitHubLandingActiveProviderAttempt({
      state: admitted.state,
      candidate: admitted.state.candidates[0],
      warrant: admitted.state.landingWarrant,
      providerAttempt,
      token: "test-token",
      now: "2026-08-12T00:35:06Z",
      fetchImpl,
    }),
    /run and job to remain active/u,
  );

  await assert.rejects(
    heartbeatDevDeliveryLandingWarrantWithGitHubProvider(
      admitted.state,
      admitted.state.landingWarrant,
      {
        providerAttempt,
        now: "2026-08-12T00:35:15Z",
        leaseSeconds: 10,
      },
    ),
    /Landing Warrant expired/u,
  );
});

test("expired Landing never cancels a run-level successor and settles only terminal exact-attempt readback", async () => {
  const input = candidate(181);
  const submitted = submitDevDeliveryAuthorityCandidate(
    authorityState({ landingLeaseSeconds: 10 }),
    input,
    { now: "2026-08-12T00:30:01Z" },
  );
  const leased = acquireDevDeliveryQualificationLease(submitted.state, {
    now: "2026-08-12T00:30:02Z",
  });
  const qualified = completeDevDeliveryQualification(
    leased.state,
    leased.lease,
    { evidenceRoot: root("a"), now: "2026-08-12T00:30:03Z" },
  );
  const landing = acquireDevDeliveryLandingWarrant(qualified.state, {
    now: "2026-08-12T00:30:04Z",
    leaseSeconds: 10,
  });
  const admitted = admitDevDeliveryMergeGroupForTesting(
    landing.state,
    landing.warrant,
    {
      mergeGroupHead: "d".repeat(40),
      providerAttempt: providerAttemptFor(input.sourceHead, "d".repeat(40)),
      now: "2026-08-12T00:30:05Z",
    },
  );
  let cancelled = false;
  let wrongHead = true;
  let synchronized = false;
  let pullRequestMerged = false;
  let providerRunLanded = false;
  let missingRunConclusion = false;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (
      request.method === "POST" &&
      request.url === "/repos/kungfu-systems/kungfu/actions/runs/1200/cancel"
    ) {
      cancelled = true;
      response.statusCode = 202;
      response.end();
      return;
    }
    if (
      request.url ===
      "/repos/kungfu-systems/kungfu/actions/runs/1200/attempts/1"
    ) {
      response.end(
        JSON.stringify({
          id: 1200,
          repository: { full_name: "kungfu-systems/kungfu" },
          workflow_id: 700,
          event: "merge_group",
          status: cancelled ? "completed" : "in_progress",
          conclusion: cancelled && !missingRunConclusion ? "cancelled" : null,
          head_sha: wrongHead ? "f".repeat(40) : "d".repeat(40),
          run_attempt: 1,
          referenced_workflows: [
            {
              path: "kungfu-systems/buildchain/.github/workflows/dev-pr-auto-merge.yml@refs/tags/v4-alpha",
              ref: "refs/tags/v4-alpha",
              sha: "c".repeat(40),
            },
          ],
        }),
      );
      return;
    }
    if (request.url === "/repos/kungfu-systems/kungfu/actions/runs/1200") {
      response.end(
        JSON.stringify({
          id: 1200,
          repository: { full_name: "kungfu-systems/kungfu" },
          workflow_id: 700,
          event: "merge_group",
          status: "in_progress",
          conclusion: null,
          head_sha: "e".repeat(40),
          run_attempt: 2,
        }),
      );
      return;
    }
    if (request.url === "/repos/kungfu-systems/kungfu/actions/jobs/1201") {
      response.end(
        JSON.stringify({
          id: 1201,
          name: "Landing authority",
          status: cancelled ? "completed" : "in_progress",
          conclusion: cancelled ? "cancelled" : null,
          run_url:
            "https://api.github.test/repos/kungfu-systems/kungfu/actions/runs/1200",
          started_at: "2026-08-12T00:30:05Z",
          completed_at: cancelled ? "2026-08-12T00:30:16Z" : null,
          runner_id: 1300,
          runner_name: "GitHub Actions 1300",
          runner_group_id: 1,
          runner_group_name: "GitHub Actions",
          labels: ["ubuntu-24.04", "X64"],
        }),
      );
      return;
    }
    if (request.url === "/repos/kungfu-systems/kungfu/actions/workflows/700") {
      response.end(
        JSON.stringify({
          id: 700,
          path: ".github/workflows/dev-pr-auto-merge.yml",
        }),
      );
      return;
    }
    if (request.url === "/repos/kungfu-systems/kungfu/pulls/181") {
      response.end(
        JSON.stringify({
          number: 181,
          state: pullRequestMerged ? "closed" : "open",
          merged_at: pullRequestMerged ? "2026-08-12T00:30:16Z" : null,
          head: {
            sha: synchronized ? "9".repeat(40) : input.sourceHead,
          },
          base: {
            ref: "dev/v4/v4.0",
            repo: { full_name: "kungfu-systems/kungfu" },
          },
        }),
      );
      return;
    }
    if (
      request.url ===
      `/repos/kungfu-systems/kungfu/compare/${"d".repeat(40)}...dev%2Fv4%2Fv4.0`
    ) {
      response.end(
        JSON.stringify({
          status: providerRunLanded ? "identical" : "diverged",
          merge_base_commit: {
            sha: providerRunLanded ? "d".repeat(40) : "e".repeat(40),
          },
        }),
      );
      return;
    }
    if (
      request.url ===
      "/repos/kungfu-systems/kungfu/git/ref/heads/dev%2Fv4%2Fv4.0"
    ) {
      response.end(
        JSON.stringify({
          object: {
            sha: providerRunLanded ? "d".repeat(40) : "8".repeat(40),
          },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const providerRequest = {
      pullRequestNumber: input.pullRequestNumber,
      sourceHead: input.sourceHead,
      outcome: "terminal-failure",
      evidenceRoot: root("f"),
      reason: "caller cannot assert provider stop",
      authorityToken: landing.warrant.token,
      authorityGeneration: landing.warrant.generation,
    };
    const providerOptions = {
      now: "2026-08-12T00:30:17Z",
      token: "test-token",
      apiUrl: `http://127.0.0.1:${address.port}`,
    };
    await assert.rejects(
      settleDevDeliveryAuthorityCandidateWithGitHubProvider(
        admitted.state,
        providerRequest,
        providerOptions,
      ),
      /run readback binding mismatch/u,
    );
    assert.equal(
      requests.some((entry) => entry.startsWith("POST ")),
      false,
    );
    wrongHead = false;
    await assert.rejects(
      settleDevDeliveryAuthorityCandidateWithGitHubProvider(
        admitted.state,
        providerRequest,
        providerOptions,
      ),
      /terminal cleanup refuses run-level cancellation/u,
    );
    assert.equal(
      requests.some((entry) => entry.startsWith("POST ")),
      false,
    );
    cancelled = true;
    synchronized = true;
    missingRunConclusion = true;
    await assert.rejects(
      settleDevDeliveryAuthorityCandidateWithGitHubProvider(
        admitted.state,
        providerRequest,
        providerOptions,
      ),
      /provider terminal conclusion is missing/u,
    );
    missingRunConclusion = false;
    pullRequestMerged = true;
    const supersededReadback = await readGitHubLandingTerminalState({
      state: admitted.state,
      candidate: admitted.state.candidates[0],
      warrant: admitted.state.landingWarrant,
      ...providerOptions,
    });
    assert.equal(supersededReadback.pullRequestMerged, true);
    assert.equal(supersededReadback.providerRunHeadInProtectedBase, false);
    assert.equal(supersededReadback.outcome, "dequeued");
    providerRunLanded = true;
    const mergedReadback = await readGitHubLandingTerminalState({
      state: admitted.state,
      candidate: admitted.state.candidates[0],
      warrant: admitted.state.landingWarrant,
      ...providerOptions,
    });
    assert.equal(mergedReadback.protectedBaseHead, "d".repeat(40));
    assert.equal(mergedReadback.providerRunHeadInProtectedBase, true);
    assert.equal(mergedReadback.outcome, "merged");
    pullRequestMerged = false;
    providerRunLanded = false;
    const settled = await settleDevDeliveryAuthorityCandidateWithGitHubProvider(
      admitted.state,
      providerRequest,
      providerOptions,
    );
    assert.equal(settled.state.landingWarrant, null);
    assert.equal(settled.receipt.outcome, "cancelled");
    assert.equal(
      requests.some(
        (entry) =>
          entry === "GET /repos/kungfu-systems/kungfu/actions/runs/1200",
      ),
      false,
    );
    assert.equal(
      requests.some((entry) => entry.startsWith("POST ")),
      false,
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Landing provider attempt is derived from exact live execution context", () => {
  const input = candidate(182);
  const submitted = submitDevDeliveryAuthorityCandidate(
    authorityState(),
    input,
    { now: "2026-08-12T00:40:01Z" },
  );
  const durableCandidate = submitted.state.candidates[0];
  const mergeGroupHead = "d".repeat(40);
  const attempt = deriveDevDeliveryLandingProviderAttempt({
    state: submitted.state,
    candidate: durableCandidate,
    mergeGroupHead,
    providerRunId: "1200",
    providerRunAttempt: "2",
    run: {
      id: 1200,
      run_attempt: 2,
      workflow_id: 700,
      event: "merge_group",
      head_sha: mergeGroupHead,
      head_branch:
        "gh-readonly-queue/dev/v4/v4.0/pr-182-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      repository: { full_name: "kungfu-systems/kungfu" },
    },
    jobs: {
      jobs: [
        {
          id: 1201,
          name: "Landing authority",
          status: "in_progress",
          runner_id: 1300,
          runner_name: "GitHub Actions 1300",
          runner_group_id: 1,
          runner_group_name: "GitHub Actions",
          labels: ["ubuntu-24.04", "X64"],
        },
      ],
    },
    workflow: { id: 700, path: ".github/workflows/check.yml" },
    pullRequest: {
      number: input.pullRequestNumber,
      head: { sha: input.sourceHead },
      base: {
        ref: "dev/v4/v4.0",
        repo: { full_name: "kungfu-systems/kungfu" },
      },
    },
  });
  assert.equal(attempt.runAttempt, 2);
  assert.equal(attempt.jobId, 1201);
  assert.equal(attempt.runnerId, 1300);
  assert.equal(attempt.workflowSha, mergeGroupHead);
  assert.equal(
    attempt.workflowRef,
    "kungfu-systems/kungfu/.github/workflows/check.yml@refs/heads/gh-readonly-queue/dev/v4/v4.0/pr-182-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  );
  assert.equal(attempt.mergeGroupHead, mergeGroupHead);
  assert.throws(
    () =>
      deriveDevDeliveryLandingProviderAttempt({
        state: submitted.state,
        candidate: durableCandidate,
        mergeGroupHead,
        providerRunId: "1200",
        providerRunAttempt: "1",
        run: {
          id: 1200,
          run_attempt: 2,
          workflow_id: 700,
          event: "merge_group",
          head_sha: mergeGroupHead,
          head_branch:
            "gh-readonly-queue/dev/v4/v4.0/pr-182-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          repository: { full_name: "kungfu-systems/kungfu" },
        },
        jobs: { jobs: [] },
        workflow: { id: 700, path: ".github/workflows/check.yml" },
        pullRequest: {},
      }),
    /current execution context mismatch/u,
  );
});

test("v2 same-PR successors must chain the latest durable terminal predecessor", () => {
  const firstInput = candidate(183);
  const first = submitDevDeliveryAuthorityCandidate(
    authorityState(),
    firstInput,
    { now: "2026-08-12T00:50:01Z" },
  );
  const cancelled = settleDevDeliveryAuthorityCandidate(
    first.state,
    {
      pullRequestNumber: firstInput.pullRequestNumber,
      sourceHead: firstInput.sourceHead,
      outcome: "cancelled",
      evidenceRoot: root("a"),
      reason: "superseded exact head",
    },
    { now: "2026-08-12T00:50:02Z" },
  );
  const successorInput = candidate(183, {
    sourceHead: "f".repeat(40),
    sourceIdentityRoot: root("f"),
  });
  const successor = submitDevDeliveryAuthorityCandidate(
    cancelled.state,
    successorInput,
    { now: "2026-08-12T00:50:03Z" },
  );
  assert.equal(
    successor.state.candidates[1].predecessorCandidateId,
    successor.state.candidates[0].candidateId,
  );
  assert.equal(
    successor.state.candidates[1].identitySemantics,
    "chained-attempt-v2",
  );

  const unchainedSuccessor = submitDevDeliveryAuthorityCandidate(
    authorityState(),
    successorInput,
    { now: "2026-08-12T00:50:03Z" },
  ).state.candidates[0];
  const invalid = structuredClone(cancelled.state);
  invalid.candidates.push(unchainedSuccessor);
  invalid.updatedAt = "2026-08-12T00:50:03.000Z";
  delete invalid.stateRoot;
  invalid.stateRoot = devDeliveryContentRoot(invalid);
  assert.throws(
    () => normalizeDevDeliveryAuthorityState(invalid),
    /same-PR successor must chain/u,
  );
});

test("issue #2410 terminal settlement releases authority immediately and is idempotent", () => {
  const submitted = submitDevDeliveryAuthorityCandidate(
    authorityState(),
    candidate(200),
    { now: "2026-08-12T01:00:01Z" },
  );
  const leased = acquireDevDeliveryQualificationLease(submitted.state, {
    now: "2026-08-12T01:00:02Z",
    leaseSeconds: 3600,
  });
  const terminalQualification = settleDevDeliveryAuthorityCandidate(
    leased.state,
    {
      pullRequestNumber: 200,
      sourceHead: candidate(200).sourceHead,
      outcome: "terminal-failure",
      evidenceRoot: root("b"),
      authorityToken: leased.lease.token,
      authorityGeneration: leased.lease.generation,
    },
    { now: "2026-08-12T01:00:03Z" },
  );

  assert.equal(terminalQualification.state.qualificationLeases.length, 0);
  assert.equal(
    terminalQualification.receipt.releasedAuthority.kind,
    "qualification-lease",
  );
  assert.ok(
    Date.parse(leased.lease.expiresAt) > Date.parse("2026-08-12T01:00:03Z"),
  );

  const first = submitDevDeliveryAuthorityCandidate(
    terminalQualification.state,
    candidate(201),
    { now: "2026-08-12T01:00:04Z" },
  );
  const qualification = acquireDevDeliveryQualificationLease(first.state, {
    now: "2026-08-12T01:00:05Z",
  });
  const qualified = completeDevDeliveryQualification(
    qualification.state,
    qualification.lease,
    { evidenceRoot: root("c"), now: "2026-08-12T01:00:06Z" },
  );
  const landing = acquireDevDeliveryLandingWarrant(qualified.state, {
    now: "2026-08-12T01:00:07Z",
    leaseSeconds: 3600,
  });
  const merged = settleDevDeliveryAuthorityCandidate(
    landing.state,
    {
      pullRequestNumber: 201,
      sourceHead: candidate(201).sourceHead,
      outcome: "merged",
      evidenceRoot: root("d"),
      authorityToken: landing.warrant.token,
      authorityGeneration: landing.warrant.generation,
    },
    { now: "2026-08-12T01:00:08Z" },
  );

  assert.equal(merged.state.landingWarrant, null);
  assert.equal(merged.receipt.releasedAuthority.kind, "landing-warrant");
  assert.ok(
    Date.parse(landing.warrant.expiresAt) > Date.parse("2026-08-12T01:00:08Z"),
  );

  const duplicate = settleDevDeliveryAuthorityCandidate(
    merged.state,
    {
      pullRequestNumber: 201,
      sourceHead: candidate(201).sourceHead,
      outcome: "merged",
      evidenceRoot: root("d"),
    },
    { now: "2026-08-12T01:00:09Z" },
  );
  assert.equal(duplicate.receipt.action, "duplicate-terminal-event-noop");
  assert.equal(duplicate.state.stateRoot, merged.state.stateRoot);
  assert.equal(duplicate.receipt.expectedOldStateRoot, merged.state.stateRoot);
  assert.equal(duplicate.receipt.nextStateRoot, merged.state.stateRoot);
  assert.equal(duplicate.state.authorityMode, DEV_DELIVERY_AUTHORITY_MODE);
});

test("v2 terminal provider evidence survives write-normalize-observe-remutate", () => {
  const input = candidate(202);
  const submitted = submitDevDeliveryAuthorityCandidate(
    authorityState(),
    input,
    {
      now: "2026-08-12T01:10:01Z",
    },
  );
  const leased = acquireDevDeliveryQualificationLease(submitted.state, {
    now: "2026-08-12T01:10:02Z",
  });
  const qualified = completeDevDeliveryQualification(
    leased.state,
    leased.lease,
    { now: "2026-08-12T01:10:03Z" },
  );
  const landing = acquireDevDeliveryLandingWarrant(qualified.state, {
    now: "2026-08-12T01:10:04Z",
  });
  const terminal = {
    pullRequestNumber: input.pullRequestNumber,
    sourceHead: input.sourceHead,
    outcome: "terminal-failure",
    evidenceRoot: root("b"),
    reason: "exact provider failure",
    authorityToken: landing.warrant.token,
    authorityGeneration: landing.warrant.generation,
    transferRoot: root("c"),
    finalizerBoundaryRoot: root("d"),
    nativeJobId: 2201,
    sealJobId: 2202,
  };
  const written = settleDevDeliveryAuthorityCandidate(landing.state, terminal, {
    now: "2026-08-12T01:10:05Z",
  });
  const normalized = normalizeDevDeliveryAuthorityState(
    JSON.parse(JSON.stringify(written.state)),
  );
  assert.equal(normalized.stateRoot, written.state.stateRoot);
  assert.deepEqual(normalized.candidates[0].terminal, {
    outcome: "terminal-failure",
    evidenceRoot: root("b"),
    reason: "exact provider failure",
    settledAt: "2026-08-12T01:10:05.000Z",
    transferRoot: root("c"),
    finalizerBoundaryRoot: root("d"),
    nativeJobId: 2201,
    sealJobId: 2202,
  });
  assert.equal(
    observeDevDeliveryAuthorityState(normalized, {
      now: "2026-08-12T01:10:06Z",
    }).stateRoot,
    written.state.stateRoot,
  );
  const repeated = settleDevDeliveryAuthorityCandidate(normalized, terminal, {
    now: "2026-08-12T01:10:07Z",
  });
  assert.equal(repeated.receipt.action, "duplicate-terminal-event-noop");
  assert.equal(repeated.state.stateRoot, written.state.stateRoot);
});

test("rooted safety domains permit disjoint leases and block overlap or unknown domains", () => {
  const domainA = root("a");
  const domainB = root("b");
  let state = submitDevDeliveryAuthorityCandidate(
    authorityState({ maxQualificationLeases: 3 }),
    candidate(210, { qualificationDomains: [domainA] }),
    { now: "2026-08-12T01:10:01Z" },
  ).state;
  state = submitDevDeliveryAuthorityCandidate(
    state,
    candidate(211, { qualificationDomains: [domainB] }),
    { now: "2026-08-12T01:10:02Z" },
  ).state;
  state = submitDevDeliveryAuthorityCandidate(
    state,
    candidate(212, { qualificationDomains: [domainA] }),
    { now: "2026-08-12T01:10:03Z" },
  ).state;
  state = submitDevDeliveryAuthorityCandidate(
    state,
    candidate(213, { qualificationDomains: [] }),
    { now: "2026-08-12T01:10:04Z" },
  ).state;

  const first = acquireDevDeliveryQualificationLease(state, {
    now: "2026-08-12T01:10:05Z",
  });
  const disjoint = acquireDevDeliveryQualificationLease(first.state, {
    now: "2026-08-12T01:10:06Z",
  });
  assert.equal(disjoint.state.qualificationLeases.length, 2);

  const blocked = acquireDevDeliveryQualificationLease(disjoint.state, {
    now: "2026-08-12T01:10:07Z",
  });
  assert.equal(blocked.lease, null);
  assert.equal(blocked.receipt.action, "qualification-safety-boundary-noop");
  assert.deepEqual(
    blocked.receipt.blockedReasons.map((reason) => reason.code),
    ["overlapping-qualification-domain", "unknown-qualification-domain"],
  );
  assert.ok(
    blocked.receipt.blockedReasons.every((reason) =>
      /^sha256:[0-9a-f]{64}$/.test(reason.reasonRoot),
    ),
  );
  assert.equal(blocked.state.stateRoot, disjoint.state.stateRoot);
});

test("bounded overtaking reserves eventual landing priority for a slow predecessor", () => {
  let state = authorityState({
    maxQualificationLeases: 4,
    maxLandingOvertakes: 2,
  });
  const inputs = [
    candidate(220, { qualificationDomains: [root("9")] }),
    candidate(221, { qualificationDomains: [root("a")] }),
    candidate(222, { qualificationDomains: [root("b")] }),
    candidate(223, { qualificationDomains: [root("c")] }),
  ];
  for (let index = 0; index < inputs.length; index += 1) {
    state = submitDevDeliveryAuthorityCandidate(state, inputs[index], {
      now: `2026-08-12T01:20:0${index + 1}Z`,
    }).state;
  }
  const leases = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const leased = acquireDevDeliveryQualificationLease(state, {
      now: `2026-08-12T01:20:1${index}Z`,
    });
    leases.push(leased.lease);
    state = leased.state;
  }

  for (let index = 1; index <= 2; index += 1) {
    state = completeDevDeliveryQualification(state, leases[index], {
      evidenceRoot: root(index === 1 ? "d" : "e"),
      now: `2026-08-12T01:20:2${index}Z`,
    }).state;
    const landing = acquireDevDeliveryLandingWarrant(state, {
      now: `2026-08-12T01:20:3${index}Z`,
    });
    assert.equal(
      landing.warrant.candidateId,
      state.candidates[index].candidateId,
    );
    state = settleDevDeliveryAuthorityCandidate(
      landing.state,
      {
        pullRequestNumber: inputs[index].pullRequestNumber,
        sourceHead: inputs[index].sourceHead,
        outcome: "merged",
        evidenceRoot: root(index === 1 ? "f" : "8"),
        authorityToken: landing.warrant.token,
        authorityGeneration: landing.warrant.generation,
      },
      { now: `2026-08-12T01:20:4${index}Z` },
    ).state;
  }

  state = completeDevDeliveryQualification(state, leases[3], {
    evidenceRoot: root("7"),
    now: "2026-08-12T01:20:50Z",
  }).state;
  const bounded = acquireDevDeliveryLandingWarrant(state, {
    now: "2026-08-12T01:20:51Z",
  });
  assert.equal(bounded.warrant, null);
  assert.equal(bounded.receipt.action, "landing-overtake-bound-noop");
  assert.equal(
    bounded.receipt.blockedReason.code,
    "landing-overtake-bound-reached",
  );
  assert.equal(state.candidates[0].landingOvertakes, 2);

  state = completeDevDeliveryQualification(state, leases[0], {
    evidenceRoot: root("6"),
    now: "2026-08-12T01:20:52Z",
  }).state;
  const priority = acquireDevDeliveryLandingWarrant(state, {
    now: "2026-08-12T01:20:53Z",
  });
  assert.equal(priority.warrant.candidateId, state.candidates[0].candidateId);
});

test("a zero overtake bound enforces strict FIFO landing priority", () => {
  let state = authorityState({
    maxQualificationLeases: 2,
    maxLandingOvertakes: 0,
  });
  const slow = candidate(224, { qualificationDomains: [root("9")] });
  const fast = candidate(225, { qualificationDomains: [root("a")] });
  state = submitDevDeliveryAuthorityCandidate(state, slow, {
    now: "2026-08-12T01:25:01Z",
  }).state;
  state = submitDevDeliveryAuthorityCandidate(state, fast, {
    now: "2026-08-12T01:25:02Z",
  }).state;
  const slowLease = acquireDevDeliveryQualificationLease(state, {
    now: "2026-08-12T01:25:03Z",
  });
  const fastLease = acquireDevDeliveryQualificationLease(slowLease.state, {
    now: "2026-08-12T01:25:04Z",
  });
  const qualifiedFast = completeDevDeliveryQualification(
    fastLease.state,
    fastLease.lease,
    { evidenceRoot: root("b"), now: "2026-08-12T01:25:05Z" },
  );
  const blocked = acquireDevDeliveryLandingWarrant(qualifiedFast.state, {
    now: "2026-08-12T01:25:06Z",
  });
  assert.equal(blocked.warrant, null);
  assert.equal(
    blocked.receipt.blockedReason.code,
    "landing-overtake-bound-reached",
  );
  const qualifiedSlow = completeDevDeliveryQualification(
    blocked.state,
    slowLease.lease,
    { evidenceRoot: root("c"), now: "2026-08-12T01:25:07Z" },
  );
  const priority = acquireDevDeliveryLandingWarrant(qualifiedSlow.state, {
    now: "2026-08-12T01:25:08Z",
  });
  assert.equal(
    priority.warrant.candidateId,
    qualifiedSlow.state.candidates[0].candidateId,
  );
});

test("heartbeat loss terminates at the attempt bound and wakes capacity idempotently", () => {
  let state = authorityState({
    maxQualificationLeases: 1,
    maxQualificationAttempts: 1,
    qualificationLeaseSeconds: 10,
  });
  state = submitDevDeliveryAuthorityCandidate(
    state,
    candidate(230, { qualificationDomains: [root("a")] }),
    { now: "2026-08-12T01:30:01Z" },
  ).state;
  state = submitDevDeliveryAuthorityCandidate(
    state,
    candidate(231, { qualificationDomains: [root("b")] }),
    { now: "2026-08-12T01:30:02Z" },
  ).state;
  const leased = acquireDevDeliveryQualificationLease(state, {
    now: "2026-08-12T01:30:03Z",
    leaseSeconds: 10,
  });
  const heartbeat = heartbeatDevDeliveryQualificationLease(
    leased.state,
    leased.lease,
    { now: "2026-08-12T01:30:08Z", leaseSeconds: 10 },
  );
  const beforeExpiry = recoverDevDeliveryAuthority(heartbeat.state, {
    now: "2026-08-12T01:30:17Z",
  });
  assert.equal(beforeExpiry.receipt.action, "no-expired-authority-noop");
  assert.equal(beforeExpiry.state.stateRoot, heartbeat.state.stateRoot);

  const recovered = recoverDevDeliveryAuthority(heartbeat.state, {
    now: "2026-08-12T01:30:19Z",
  });
  const duplicateController = recoverDevDeliveryAuthority(heartbeat.state, {
    now: "2026-08-12T01:30:19Z",
  });
  assert.equal(
    duplicateController.receipt.expectedOldStateRoot,
    recovered.receipt.expectedOldStateRoot,
  );
  assert.equal(duplicateController.state.stateRoot, recovered.state.stateRoot);
  assert.equal(duplicateController.wake.wakeRoot, recovered.wake.wakeRoot);
  assert.equal(recovered.state.qualificationLeases.length, 0);
  assert.equal(recovered.state.candidates[0].status, "terminal-failure");
  assert.equal(
    recovered.state.candidates[0].terminal.reason,
    "qualification-heartbeat-expired-terminal",
  );
  assert.deepEqual(recovered.wake.qualificationCandidateIds, [
    recovered.state.candidates[1].candidateId,
  ]);

  const duplicate = recoverDevDeliveryAuthority(recovered.state, {
    now: "2026-08-12T01:30:19Z",
  });
  assert.equal(duplicate.state.stateRoot, recovered.state.stateRoot);
  assert.equal(duplicate.wake.wakeRoot, recovered.wake.wakeRoot);
});

test("cancellation and already-merged reconciliation release and wake exactly once", () => {
  let state = authorityState({ maxQualificationLeases: 1 });
  const cancelledInput = candidate(240, { qualificationDomains: [root("a")] });
  const nextInput = candidate(241, { qualificationDomains: [root("b")] });
  state = submitDevDeliveryAuthorityCandidate(state, cancelledInput, {
    now: "2026-08-12T01:40:01Z",
  }).state;
  state = submitDevDeliveryAuthorityCandidate(state, nextInput, {
    now: "2026-08-12T01:40:02Z",
  }).state;
  const leased = acquireDevDeliveryQualificationLease(state, {
    now: "2026-08-12T01:40:03Z",
  });
  const cancelled = settleDevDeliveryAuthorityCandidate(
    leased.state,
    {
      pullRequestNumber: cancelledInput.pullRequestNumber,
      sourceHead: cancelledInput.sourceHead,
      outcome: "cancelled",
      evidenceRoot: root("c"),
      authorityToken: leased.lease.token,
      authorityGeneration: leased.lease.generation,
    },
    { now: "2026-08-12T01:40:04Z" },
  );
  assert.deepEqual(cancelled.wake.qualificationCandidateIds, [
    cancelled.state.candidates[1].candidateId,
  ]);
  const duplicateCancellation = settleDevDeliveryAuthorityCandidate(
    cancelled.state,
    {
      pullRequestNumber: cancelledInput.pullRequestNumber,
      sourceHead: cancelledInput.sourceHead,
      outcome: "cancelled",
      evidenceRoot: root("c"),
    },
    { now: "2026-08-12T01:40:05Z" },
  );
  assert.equal(
    duplicateCancellation.state.stateRoot,
    cancelled.state.stateRoot,
  );
  assert.equal(duplicateCancellation.wake.wakeRoot, cancelled.wake.wakeRoot);

  const nextLease = acquireDevDeliveryQualificationLease(cancelled.state, {
    now: "2026-08-12T01:40:06Z",
  });
  const qualified = completeDevDeliveryQualification(
    nextLease.state,
    nextLease.lease,
    { evidenceRoot: root("d"), now: "2026-08-12T01:40:07Z" },
  );
  const landing = acquireDevDeliveryLandingWarrant(qualified.state, {
    now: "2026-08-12T01:40:08Z",
  });
  const merged = settleDevDeliveryAuthorityCandidate(
    landing.state,
    {
      pullRequestNumber: nextInput.pullRequestNumber,
      sourceHead: nextInput.sourceHead,
      outcome: "merged",
      evidenceRoot: root("e"),
      authorityToken: landing.warrant.token,
      authorityGeneration: landing.warrant.generation,
      reason: "provider-already-merged-reconciliation",
    },
    { now: "2026-08-12T01:40:09Z" },
  );
  assert.equal(merged.state.landingWarrant, null);
  assert.equal(merged.receipt.releasedAuthority.kind, "landing-warrant");
  assert.equal(
    observeDevDeliveryAuthorityState(merged.state, {
      now: "2026-08-12T01:40:10Z",
    }).landing.active,
    null,
  );
});

test("stress scheduling never exposes more than one Landing Warrant", () => {
  let state = authorityState({
    maxQualificationLeases: 4,
    maxLandingOvertakes: 3,
  });
  const inputs = Array.from({ length: 24 }, (_, index) =>
    candidate(500 + index, {
      qualificationDomains: [
        `sha256:${(index + 1).toString(16).padStart(64, "0")}`,
      ],
    }),
  );
  for (let index = 0; index < inputs.length; index += 1) {
    state = submitDevDeliveryAuthorityCandidate(state, inputs[index], {
      now: new Date(
        Date.parse("2026-08-12T04:00:00Z") + index * 1000,
      ).toISOString(),
    }).state;
  }

  let clock = Date.parse("2026-08-12T04:01:00Z");
  let maximumLandingWarrants = 0;
  while (
    state.candidates.some(
      (entry) =>
        !["merged", "terminal-failure", "dequeued", "cancelled"].includes(
          entry.status,
        ),
    )
  ) {
    while (
      state.qualificationLeases.length < state.policy.maxQualificationLeases &&
      state.candidates.some((entry) => entry.status === "queued")
    ) {
      state = acquireDevDeliveryQualificationLease(state, {
        now: new Date(clock++).toISOString(),
      }).state;
    }
    for (const lease of [...state.qualificationLeases]) {
      state = completeDevDeliveryQualification(state, lease, {
        evidenceRoot: root("a"),
        now: new Date(clock++).toISOString(),
      }).state;
    }
    const landing = acquireDevDeliveryLandingWarrant(state, {
      now: new Date(clock++).toISOString(),
    });
    state = landing.state;
    const observation = observeDevDeliveryAuthorityState(state, {
      now: new Date(clock++).toISOString(),
    });
    maximumLandingWarrants = Math.max(
      maximumLandingWarrants,
      Number(Boolean(observation.landing.active)),
    );
    assert.equal(
      state.candidates.filter((entry) => entry.status === "landing").length,
      Number(Boolean(observation.landing.active)),
    );
    const input = inputs.find(
      (entry) =>
        entry.pullRequestNumber ===
        state.candidates.find(
          (entry) => entry.candidateId === landing.warrant.candidateId,
        ).pullRequestNumber,
    );
    state = settleDevDeliveryAuthorityCandidate(
      state,
      {
        pullRequestNumber: input.pullRequestNumber,
        sourceHead: input.sourceHead,
        outcome: "merged",
        evidenceRoot: root("b"),
        authorityToken: landing.warrant.token,
        authorityGeneration: landing.warrant.generation,
      },
      { now: new Date(clock++).toISOString() },
    ).state;
  }
  assert.equal(maximumLandingWarrants, 1);
  assert.equal(
    state.candidates.filter((entry) => entry.status === "merged").length,
    inputs.length,
  );
});

test("public authority CLI stays opt-in and persists through expected-old state writes", async () => {
  const initial = authorityState();
  const writes = [];
  const store = {
    async read() {
      return { exists: true, commitSha: "a".repeat(40), queue: initial };
    },
    async write(input) {
      writes.push(input);
      return { commitSha: "f".repeat(40), stateRoot: input.queue.stateRoot };
    },
  };
  const parsed = devDeliveryAuthorityCliOptions([
    "observe",
    "--repository",
    "kungfu-systems/kungfu",
    "--branch",
    "dev/v4/v4.0",
  ]);
  assert.equal(parsed.command, "observe");
  const heartbeatParsed = devDeliveryAuthorityCliOptions([
    "heartbeat-landing",
    "--repository",
    "kungfu-systems/kungfu",
    "--branch",
    "dev/v4/v4.0",
    "--provider-attempt",
    "admitted-provider-attempt.json",
  ]);
  assert.equal(
    heartbeatParsed.providerAttemptPath,
    "admitted-provider-attempt.json",
  );
  assert.equal(
    defaultDevDeliveryAuthorityStateRef("dev/v4/v4.0"),
    "buildchain/dev-delivery-authority/dev-v4-v4.0",
  );

  const result = await runDevDeliveryAuthorityCommand(
    {
      command: "submit",
      repository: "kungfu-systems/kungfu",
      branch: "dev/v4/v4.0",
      now: "2026-08-12T02:00:00Z",
      execute: true,
      ...candidate(300),
    },
    store,
  );
  assert.equal(result.mutationAuthorized, true);
  assert.equal(result.mutationApplied, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].expectedStateRoot, initial.stateRoot);
  assert.equal(result.observation.authorityMode, DEV_DELIVERY_AUTHORITY_MODE);

  await assert.rejects(
    runDevDeliveryAuthorityCommand(
      {
        command: "submit",
        repository: "kungfu-systems/kungfu",
        branch: "dev/v4/v4.0",
        now: "2026-08-12T02:00:01Z",
        execute: true,
        ...candidate(301),
      },
      {
        async read() {
          return { exists: false, commitSha: "", queue: initial };
        },
      },
    ),
    /explicitly migrate the exact current v1 state/u,
  );
});

test("public migration command requires an empty target and writes one rooted v2 state", async () => {
  const legacy = createDevDeliveryQueue({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    now: "2026-08-12T03:00:00Z",
  });
  const selected = selectDevDeliveryWarrant(
    submitLegacyDevDeliveryCandidate(legacy, candidate(400), {
      now: "2026-08-12T03:00:01Z",
    }).queue,
    { now: "2026-08-12T03:00:02Z" },
  );
  const initial = authorityState();
  const writes = [];
  const store = {
    async read() {
      return { exists: false, commitSha: "", queue: initial };
    },
    async write(input) {
      writes.push(input);
      return { commitSha: "e".repeat(40), stateRoot: input.queue.stateRoot };
    },
  };
  const result = await runDevDeliveryAuthorityCommand(
    {
      command: "migrate",
      repository: "kungfu-systems/kungfu",
      branch: "dev/v4/v4.0",
      now: "2026-08-12T03:00:03Z",
      execute: true,
      legacyState: selected.queue,
    },
    store,
  );

  assert.equal(writes.length, 1);
  assert.equal(result.receipt.legacyStateRoot, selected.queue.stateRoot);
  assert.equal(result.observation.qualification.active.length, 1);
  assert.equal(result.mutationApplied, true);
});
