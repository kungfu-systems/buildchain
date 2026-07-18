import assert from "node:assert/strict";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import kfd7ActionContractSchema from "@kungfu-tech/kfd/schemas/kfd-7/action-contract.schema.json" with { type: "json" };

import {
  BUILDCHAIN_KFD7_ACTION_CONTRACT,
  BUILDCHAIN_KFD7_ROLES,
  buildchainKfd7SessionValidActions,
  createBuildchainKfd7ProfileSnapshot,
  createBuildchainKfd7ReleaseSession,
  expandBuildchainKfd7ReleaseSession,
  projectBuildchainKfd7ReleaseSession,
  validateBuildchainKfd7ProfileSnapshot,
} from "../packages/core/kfd7-buildchain-profile.js";
import { createPublicationAdmission } from "../packages/core/publication-authority.js";
import {
  createReleaseCandidatePassport,
  sha256Json,
} from "../packages/core/release-candidate.js";
import {
  createReleaseTransaction,
  transitionReleaseTransaction,
} from "../packages/core/publish-transaction.js";

const SOURCE_SHA = "a".repeat(40);
const RUNTIME_SHA = "b".repeat(40);
const DIGEST = "c".repeat(64);
const ISSUED_AT = "2026-07-18T08:00:00.000Z";
const EXPIRES_AT = "2026-07-18T08:10:00.000Z";
const OBSERVED_AT = "2026-07-18T08:05:00.000Z";

function fixture() {
  const transaction = createReleaseTransaction({
    repository: "kungfu-systems/buildchain",
    version: "2.12.9-alpha.1",
    channel: "alpha",
    line: "v2.12",
    sourceSha: SOURCE_SHA,
    targetRef: "alpha/v2/v2.12",
    releaseSha: SOURCE_SHA,
  });
  const gateAggregateInput = {
    contract: "buildchain.shifu-gate-aggregate/v1",
    profile: "release-qualification",
    sourceSha: transaction.source_sha,
    registry: { projectId: "buildchain", digest: `sha256:${DIGEST}` },
    matrixDigest: `sha256:${DIGEST}`,
    status: "pass",
    qualifying: true,
    receipts: [],
    gates: [],
  };
  const gateAggregate = {
    ...gateAggregateInput,
    digest: `sha256:${sha256Json(gateAggregateInput)}`,
  };
  const candidatePassport = createReleaseCandidatePassport({
    repository: transaction.repository,
    targetChannel: transaction.channel,
    version: transaction.version,
    sourceHeadSha: transaction.source_sha,
    mergeRefSha: transaction.source_sha,
    sourceTreeHash: "d".repeat(40),
    buildSummary: { contract: "buildchain.test-summary/v1", platforms: [] },
    buildchain: {
      ref: "v2-alpha",
      sha: RUNTIME_SHA,
      version: "2.12.9-alpha.1",
    },
    gateAggregate,
  });
  const publicationAdmission = createPublicationAdmission({
    registryDigest: DIGEST,
    workflowPath: ".github/workflows/release-candidate-promote.yml",
    publisherWorkflowPath: ".github/workflows/.publication-authority.yml",
    repository: transaction.repository,
    sourceSha: transaction.source_sha,
    runtimeSha: RUNTIME_SHA,
    contractDigest: DIGEST,
    policyDigest: DIGEST,
    controllerReceiptDigest: DIGEST,
    runnerProvenanceDigest: DIGEST,
    controlPlaneAuditDigest: DIGEST,
    gateAggregateDigest: DIGEST,
    environment: "npm-production",
    product: "@kungfu-tech/buildchain",
    target: "registry.npmjs.org",
    version: transaction.version,
    channel: transaction.channel,
    artifactDigest: DIGEST,
    nonce: "kfd7-independent-profile",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  return { transaction, candidatePassport, publicationAdmission };
}

test("Buildchain declares a schema-valid non-Kungfu KFD-7 Profile", () => {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  const validate = ajv.compile(kfd7ActionContractSchema);

  assert.equal(
    validate(BUILDCHAIN_KFD7_ACTION_CONTRACT),
    true,
    validate.errors,
  );
  assert.equal(BUILDCHAIN_KFD7_ACTION_CONTRACT.profile.product, "buildchain");
  assert.equal(
    BUILDCHAIN_KFD7_ACTION_CONTRACT.profile.qualificationStatus,
    "qualified",
  );
  assert.equal(BUILDCHAIN_KFD7_ACTION_CONTRACT.activation.decision, "activate");
  assert.equal(
    BUILDCHAIN_KFD7_ACTION_CONTRACT.activation.independentReview,
    "https://github.com/kungfu-systems/buildchain/pull/1383#pullrequestreview-4728683864",
  );
  const serialized = JSON.stringify(BUILDCHAIN_KFD7_ACTION_CONTRACT);
  for (const productTerm of [
    "RocksDB",
    "Fact kernel",
    "native Mission",
    "Kungfu Episode",
  ]) {
    assert.equal(serialized.includes(productTerm), false, productTerm);
  }
});

test("release authorities project to five independent roles without owning them", () => {
  const input = fixture();
  const snapshot = createBuildchainKfd7ProfileSnapshot({
    ...input,
    observedAt: OBSERVED_AT,
  });

  assert.equal(snapshot.status, "current");
  assert.deepEqual(snapshot.roleOrder, [...BUILDCHAIN_KFD7_ROLES]);
  assert.deepEqual(
    Object.fromEntries(
      BUILDCHAIN_KFD7_ROLES.map((role) => [role, snapshot.roles[role].state]),
    ),
    {
      fact: "declared",
      episode: "open",
      pursuit: "active",
      atlas: "current",
      warrant: "issued",
    },
  );
  assert.equal(
    new Set(BUILDCHAIN_KFD7_ROLES.map((role) => snapshot.roles[role].identity))
      .size,
    5,
  );
  assert.equal(validateBuildchainKfd7ProfileSnapshot(snapshot).ok, true);
});

test("each role deletion and representative fusion fails closed", () => {
  const snapshot = createBuildchainKfd7ProfileSnapshot({
    ...fixture(),
    observedAt: OBSERVED_AT,
  });
  for (const role of BUILDCHAIN_KFD7_ROLES) {
    const missing = structuredClone(snapshot);
    delete missing.roles[role];
    assert.equal(
      validateBuildchainKfd7ProfileSnapshot(missing).ok,
      false,
      role,
    );
  }
  for (const [left, right] of [
    ["fact", "episode"],
    ["episode", "pursuit"],
    ["pursuit", "atlas"],
    ["atlas", "warrant"],
    ["fact", "warrant"],
  ]) {
    const fused = structuredClone(snapshot);
    fused.roles[right].identity = fused.roles[left].identity;
    const validation = validateBuildchainKfd7ProfileSnapshot(fused);
    assert.equal(validation.ok, false, `${left}+${right}`);
    assert.ok(validation.errors.includes("role-identity-fusion"));
  }
});

test("same release context cannot replace source, lifecycle, or publication authority", () => {
  const input = fixture();
  const current = createBuildchainKfd7ProfileSnapshot({
    ...input,
    observedAt: OBSERVED_AT,
  });

  const staleCandidate = structuredClone(input.candidatePassport);
  staleCandidate.source.headSha = "e".repeat(40);
  const stale = createBuildchainKfd7ProfileSnapshot({
    ...input,
    candidatePassport: staleCandidate,
    observedAt: OBSERVED_AT,
  });
  assert.equal(stale.status, "denied");
  assert.ok(
    stale.issues.some((issue) => issue.includes("source head mismatch")),
  );

  const expired = createBuildchainKfd7ProfileSnapshot({
    ...input,
    observedAt: "2026-07-18T08:11:00.000Z",
  });
  assert.equal(expired.status, "degraded");
  assert.equal(expired.roles.warrant.state, "expired");

  let completedTransaction = transitionReleaseTransaction(
    input.transaction,
    "publishing",
  );
  completedTransaction = transitionReleaseTransaction(
    completedTransaction,
    "published",
  );
  completedTransaction = transitionReleaseTransaction(
    completedTransaction,
    "complete",
  );
  const completed = createBuildchainKfd7ProfileSnapshot({
    ...input,
    transaction: completedTransaction,
    observedAt: OBSERVED_AT,
  });
  assert.equal(completed.roles.episode.state, "sealed");
  assert.equal(completed.roles.pursuit.state, "completed");
  assert.equal(completed.roles.fact.state, "superseded");

  assert.equal(current.source.candidateHash, expired.source.candidateHash);
  assert.notEqual(current.roles.warrant.root, expired.roles.warrant.root);
  assert.notEqual(current.roles.episode.root, completed.roles.episode.root);
  assert.notEqual(current.roles.pursuit.root, completed.roles.pursuit.root);
});

test("tampered admission digest is denied before any profile state is produced", () => {
  const input = fixture();
  input.publicationAdmission.admissionDigest = "f".repeat(64);
  const denied = createBuildchainKfd7ProfileSnapshot({
    ...input,
    observedAt: OBSERVED_AT,
  });

  assert.equal(denied.status, "denied");
  assert.equal(denied.failureCode, "publication-admission-digest-mismatch");
  assert.equal(denied.writeOccurred, false);
  assert.deepEqual(denied.roles, {});
});

test("simple release session round-trips all five decision observations", () => {
  const session = createBuildchainKfd7ReleaseSession({
    ...fixture(),
    observedAt: OBSERVED_AT,
  });
  const expanded = expandBuildchainKfd7ReleaseSession(session);

  assert.equal(expanded.compressibility.compressible, true);
  assert.deepEqual(expanded.compressibility.breakpoints, []);
  assert.deepEqual(
    Object.keys(expanded.observations).sort(),
    [
      "admitted-result",
      "causal-process",
      "direction",
      "effective-authority",
      "perspective-boundary",
    ],
  );
  assert.deepEqual(projectBuildchainKfd7ReleaseSession(expanded), session);
});

test("release session complexity breakpoints reveal each independent role", () => {
  const baseline = createBuildchainKfd7ReleaseSession({
    ...fixture(),
    observedAt: OBSERVED_AT,
  });
  const mutations = {
    pursuit: (session) => session.goal.alternatives.push("release-intent:other"),
    atlas: (session) => session.context.views.push("candidate:other"),
    warrant: (session) => session.permissions.admissions.push("admission:other"),
    episode: (session) => session.run.transactionIds.push("transaction:retry"),
    fact: (session) => session.facts.branchRoots.push(`sha256:${"e".repeat(64)}`),
  };
  for (const [role, mutate] of Object.entries(mutations)) {
    const session = structuredClone(baseline);
    mutate(session);
    const expanded = expandBuildchainKfd7ReleaseSession(session);
    assert.equal(expanded.compressibility.compressible, false, role);
    assert.ok(expanded.compressibility.revealedRoles.includes(role), role);
    assert.throws(
      () => projectBuildchainKfd7ReleaseSession(expanded),
      /session-complexity-breakpoint/,
    );
  }
});

test("same candidate payload has different actions without intent authority or current context", () => {
  const baseline = createBuildchainKfd7ReleaseSession({
    ...fixture(),
    observedAt: OBSERVED_AT,
  });
  const candidatePayload = structuredClone(baseline.facts);
  assert.deepEqual(buildchainKfd7SessionValidActions(baseline), [
    "publish-release",
  ]);

  const noIntent = structuredClone(baseline);
  noIntent.goal.operations = ["inspect-release"];
  const noAuthority = structuredClone(baseline);
  noAuthority.permissions.allowedOperations = ["inspect-release"];
  const staleContext = structuredClone(baseline);
  staleContext.context.state = "stale";

  for (const session of [noIntent, noAuthority, staleContext])
    assert.deepEqual(session.facts, candidatePayload);
  assert.deepEqual(buildchainKfd7SessionValidActions(noIntent), []);
  assert.deepEqual(buildchainKfd7SessionValidActions(noAuthority), []);
  assert.deepEqual(buildchainKfd7SessionValidActions(staleContext), []);
});
