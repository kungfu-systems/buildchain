import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { createDevDeliveryQueue, selectDevDeliveryWarrant, submitDevDeliveryCandidate as submitLegacyDevDeliveryCandidate } from "../packages/core/dev-delivery-warrant.js";
import { DEV_DELIVERY_AUTHORITY_MODE, acquireDevDeliveryLandingWarrant, acquireDevDeliveryQualificationLease, admitDevDeliveryMergeGroup, completeDevDeliveryQualification, createDevDeliveryAuthorityState, migrateDevDeliveryAuthorityState, normalizeDevDeliveryAuthorityState, settleDevDeliveryAuthorityCandidate, submitDevDeliveryAuthorityCandidate } from "../packages/core/dev-delivery-authority.js";
import { defaultDevDeliveryAuthorityStateRef, devDeliveryAuthorityCliOptions, runDevDeliveryAuthorityCommand } from "../scripts/dev-delivery-authority.mjs";

const root = (digit) => `sha256:${digit.repeat(64)}`;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function candidate(number) {
  const digit = ((number % 8) + 1).toString(16);
  return {
    pullRequestNumber: number,
    sourceHead: digit.repeat(40),
    assignmentRoot: root("1"),
    initiativeRoot: root("2"),
    sourceIdentityRoot: root(digit),
    sourcePatchRoot: root("3"),
    sourceProofRoot: root("4"),
    planRoot: root("5"),
    closureRoot: root("6"),
    dependencyRoot: root("7"),
    toolchainRoot: root("8"),
    deliveryClass: "native-proof-required",
  };
}

function authorityState() {
  return createDevDeliveryAuthorityState({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    policy: {
      maxQualificationLeases: 2,
      qualificationLeaseSeconds: 600,
      landingLeaseSeconds: 300,
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

test("machine-readable v2 schema accepts the normalized authority state", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "contracts/dev-delivery-authority-v2.schema.json"), "utf8"));
  const ajv = new Ajv2020({ strict: false, formats: { "date-time": true } });
  const validate = ajv.compile(schema);
  assert.equal(validate(authorityState()), true, JSON.stringify(validate.errors));

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
  assert.equal(migrated.state.migration.legacyStateRoot, selected.queue.stateRoot);
  assert.equal(migrated.state.landingWarrant, null);
  assert.equal(migrated.state.qualificationLeases.length, 1);
  assert.equal(migrated.state.qualificationLeases[0].token, selected.warrant.fencingToken);
  assert.equal(migrated.state.qualificationLeases[0].generation, selected.warrant.generation);
  assert.equal(migrated.state.qualificationLeases[0].mergeGroupAdmission, false);
  assert.throws(() => admitDevDeliveryMergeGroup(migrated.state, migrated.state.qualificationLeases[0], { mergeGroupHead: "a".repeat(40), now: "2026-08-12T00:00:04Z" }), /Qualification Lease cannot admit merge_group/);
});

test("bounded Qualification Leases cannot admit merge_group and Landing remains exclusive", () => {
  const first = submitDevDeliveryAuthorityCandidate(authorityState(), candidate(100), { now: "2026-08-12T00:00:01Z" });
  const second = submitDevDeliveryAuthorityCandidate(first.state, candidate(101), { now: "2026-08-12T00:00:02Z" });
  const leasedFirst = acquireDevDeliveryQualificationLease(second.state, {
    now: "2026-08-12T00:00:03Z",
  });
  const leasedSecond = acquireDevDeliveryQualificationLease(leasedFirst.state, {
    now: "2026-08-12T00:00:04Z",
  });

  assert.equal(leasedSecond.state.qualificationLeases.length, 2);
  assert.equal(leasedSecond.lease.mergeGroupAdmission, false);

  const qualifiedFirst = completeDevDeliveryQualification(leasedSecond.state, leasedFirst.lease, { evidenceRoot: root("9"), now: "2026-08-12T00:00:05Z" });
  const landingFirst = acquireDevDeliveryLandingWarrant(qualifiedFirst.state, {
    now: "2026-08-12T00:00:06Z",
  });

  assert.throws(
    () =>
      admitDevDeliveryMergeGroup(landingFirst.state, leasedSecond.lease, {
        mergeGroupHead: "a".repeat(40),
        now: "2026-08-12T00:00:07Z",
      }),
    /Qualification Lease cannot admit merge_group/,
  );

  const qualifiedSecond = completeDevDeliveryQualification(landingFirst.state, leasedSecond.lease, { evidenceRoot: root("a"), now: "2026-08-12T00:00:08Z" });
  const retained = acquireDevDeliveryLandingWarrant(qualifiedSecond.state, {
    now: "2026-08-12T00:00:09Z",
  });

  assert.equal(retained.receipt.action, "exclusive-landing-warrant-retained-noop");

  const duplicateController = acquireDevDeliveryLandingWarrant(qualifiedSecond.state, { now: "2026-08-12T00:00:09Z" });
  assert.equal(duplicateController.state.stateRoot, retained.state.stateRoot);
  assert.equal(duplicateController.warrant.token, retained.warrant.token);
  assert.equal(retained.warrant.candidateId, landingFirst.warrant.candidateId);
  assert.equal(retained.state.stateRoot, qualifiedSecond.state.stateRoot);
  assert.equal(retained.state.candidates.filter((entry) => entry.status === "landing").length, 1);

  const admission = admitDevDeliveryMergeGroup(retained.state, retained.warrant, {
    mergeGroupHead: "b".repeat(40),
    now: "2026-08-12T00:00:10Z",
  });
  assert.equal(admission.admission.authority, "exclusive-landing-warrant");
  assert.equal(admission.admission.candidateId, landingFirst.warrant.candidateId);

  const drifted = structuredClone(retained.state);
  drifted.landingWarrant = {
    ...drifted.landingWarrant,
    candidateId: qualifiedSecond.state.candidates[1].candidateId,
  };
  delete drifted.stateRoot;
  assert.throws(() => normalizeDevDeliveryAuthorityState(drifted), /exclusive Landing Warrant must match one landing candidate/);
});

test("stale qualification and Landing fencing fail closed", () => {
  const submitted = submitDevDeliveryAuthorityCandidate(authorityState(), candidate(150), { now: "2026-08-12T00:10:01Z" });
  const leased = acquireDevDeliveryQualificationLease(submitted.state, {
    now: "2026-08-12T00:10:02Z",
  });
  assert.throws(() => completeDevDeliveryQualification(leased.state, { ...leased.lease, generation: leased.lease.generation + 1 }, { evidenceRoot: root("9"), now: "2026-08-12T00:10:03Z" }), /stale qualification lease generation/);
  const qualified = completeDevDeliveryQualification(leased.state, leased.lease, { evidenceRoot: root("9"), now: "2026-08-12T00:10:03Z" });
  const landing = acquireDevDeliveryLandingWarrant(qualified.state, {
    now: "2026-08-12T00:10:04Z",
  });
  assert.throws(() => admitDevDeliveryMergeGroup(landing.state, { ...landing.warrant, token: root("f") }, { mergeGroupHead: "b".repeat(40), now: "2026-08-12T00:10:05Z" }), /stale Landing Warrant token/);
});

test("proof drift and merge settlement without Landing authority fail closed", () => {
  const submitted = submitDevDeliveryAuthorityCandidate(authorityState(), candidate(175), {
    now: "2026-08-12T00:20:01Z",
  });
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

test("issue #2410 terminal settlement releases authority immediately and is idempotent", () => {
  const submitted = submitDevDeliveryAuthorityCandidate(authorityState(), candidate(200), { now: "2026-08-12T01:00:01Z" });
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
  assert.equal(terminalQualification.receipt.releasedAuthority.kind, "qualification-lease");
  assert.ok(Date.parse(leased.lease.expiresAt) > Date.parse("2026-08-12T01:00:03Z"));

  const first = submitDevDeliveryAuthorityCandidate(terminalQualification.state, candidate(201), { now: "2026-08-12T01:00:04Z" });
  const qualification = acquireDevDeliveryQualificationLease(first.state, {
    now: "2026-08-12T01:00:05Z",
  });
  const qualified = completeDevDeliveryQualification(qualification.state, qualification.lease, { evidenceRoot: root("c"), now: "2026-08-12T01:00:06Z" });
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
  assert.ok(Date.parse(landing.warrant.expiresAt) > Date.parse("2026-08-12T01:00:08Z"));

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

test("public authority CLI stays opt-in and persists through expected-old state writes", async () => {
  const initial = authorityState();
  const writes = [];
  const store = {
    async read() {
      return { exists: false, commitSha: "", queue: initial };
    },
    async write(input) {
      writes.push(input);
      return { commitSha: "f".repeat(40), stateRoot: input.queue.stateRoot };
    },
  };
  const parsed = devDeliveryAuthorityCliOptions(["observe", "--repository", "kungfu-systems/kungfu", "--branch", "dev/v4/v4.0"]);
  assert.equal(parsed.command, "observe");
  assert.equal(defaultDevDeliveryAuthorityStateRef("dev/v4/v4.0"), "buildchain/dev-delivery-authority/dev-v4-v4.0");

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
