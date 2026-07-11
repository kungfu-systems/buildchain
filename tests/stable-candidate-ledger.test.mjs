import assert from "node:assert/strict";
import test from "node:test";
import {
  createStableCandidateLedger,
  markStableCandidatePromoted,
  qualifyStableCandidate,
  registerStableCandidate,
  revokeStableCandidate,
  selectStableCandidate,
  setStableCandidateHold,
  stableCandidatePromotionRefs,
} from "../packages/core/stable-candidate-ledger.js";

const SHA4 = "4".repeat(40);
const SHA5 = "5".repeat(40);

function ledger() {
  return createStableCandidateLedger({
    repository: "kungfu-systems/example",
    targetBranch: "release/v2/v2.12",
    now: "2026-07-11T00:00:00Z",
  });
}

function register(input, version, sha, publishedAt) {
  return registerStableCandidate(input, { version, sha, publishedAt }, { now: publishedAt });
}

function qualify(input, version, sha, completedAt, now) {
  return qualifyStableCandidate(input, {
    version,
    sha,
    checks: [
      { id: "build", status: "pass", completedAt, evidenceUrl: "https://example.test/build" },
      { id: "consumer", status: "pass", completedAt, evidenceUrl: "https://example.test/canary" },
    ],
  }, { minimumSoakSeconds: 3600, now });
}

test("new alpha does not supersede an older qualified candidate", () => {
  let state = register(ledger(), "2.12.0-alpha.4", SHA4, "2026-07-11T00:00:00Z");
  state = qualify(state, "2.12.0-alpha.4", SHA4, "2026-07-11T00:10:00Z", "2026-07-11T01:10:00Z");
  state = register(state, "2.12.0-alpha.5", SHA5, "2026-07-11T02:50:00Z");
  state = qualify(state, "2.12.0-alpha.5", SHA5, "2026-07-11T02:55:00Z", "2026-07-11T03:00:00Z");

  assert.equal(state.candidates.find((entry) => entry.version.endsWith("alpha.4")).state, "qualified");
  assert.equal(state.candidates.find((entry) => entry.version.endsWith("alpha.5")).state, "soaking");
  assert.equal(selectStableCandidate(state).candidate.version, "2.12.0-alpha.4");
});

test("selection uses the newest qualified non-revoked candidate", () => {
  let state = register(ledger(), "2.12.0-alpha.4", SHA4, "2026-07-11T00:00:00Z");
  state = register(state, "2.12.0-alpha.5", SHA5, "2026-07-11T00:20:00Z");
  state = qualify(state, "2.12.0-alpha.4", SHA4, "2026-07-11T00:10:00Z", "2026-07-11T02:00:00Z");
  state = qualify(state, "2.12.0-alpha.5", SHA5, "2026-07-11T00:30:00Z", "2026-07-11T02:00:00Z");
  assert.equal(selectStableCandidate(state).candidate.version, "2.12.0-alpha.5");

  state = revokeStableCandidate(state, "2.12.0-alpha.5", {
    reason: "consumer regression",
    actor: "maintainer",
    now: "2026-07-11T02:05:00Z",
  });
  assert.equal(selectStableCandidate(state).candidate.version, "2.12.0-alpha.4");
});

test("hold blocks scheduled selection while release-now remains explicit", () => {
  let state = register(ledger(), "2.12.0-alpha.4", SHA4, "2026-07-11T00:00:00Z");
  state = qualify(state, "2.12.0-alpha.4", SHA4, "2026-07-11T00:10:00Z", "2026-07-11T02:00:00Z");
  state = setStableCandidateHold(state, true, { reason: "release freeze", now: "2026-07-11T02:10:00Z" });
  assert.equal(selectStableCandidate(state).reason, "repository-held");
  assert.equal(selectStableCandidate(state, { releaseNow: "2.12.0-alpha.4" }).reason, "human-release-now");
});

test("candidate identity is immutable and promotion consumes the stable version", () => {
  let state = register(ledger(), "2.12.0-alpha.4", SHA4, "2026-07-11T00:00:00Z");
  assert.throws(
    () => register(state, "2.12.0-alpha.4", SHA5, "2026-07-11T00:00:00Z"),
    /already bound/,
  );
  state = register(state, "2.12.0-alpha.5", SHA5, "2026-07-11T00:20:00Z");
  state = qualify(state, "2.12.0-alpha.4", SHA4, "2026-07-11T00:10:00Z", "2026-07-11T02:00:00Z");
  state = markStableCandidatePromoted(state, "2.12.0-alpha.4", {
    stableSha: "a".repeat(40),
    now: "2026-07-11T03:00:00Z",
  });
  assert.equal(state.candidates[0].state, "promoted");
  assert.equal(state.candidates[1].state, "revoked");
  assert.match(state.candidates[1].decision.reason, /stable-version-promoted-by/);
});

test("promotion refs freeze the exact qualified alpha tree", () => {
  assert.deepEqual(
    stableCandidatePromotionRefs({ version: "2.12.0-alpha.4" }, "release/v2/v2.12"),
    {
      sourceRef: "publish-gate/release/v2/v2.12/2.12.0-alpha.4",
      targetRef: "release/v2/v2.12",
      exactAlphaTag: "v2.12.0-alpha.4",
      stableTag: "v2.12.0",
    },
  );
});
