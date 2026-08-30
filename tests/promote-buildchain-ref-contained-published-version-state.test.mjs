import assert from "node:assert/strict";
import test from "node:test";

import {
  containedPublishedReleaseCandidateVersion,
  containedPublishedVersionState,
} from "../actions/promote-buildchain-ref/internal/contained-published-version-state.js";

const SHA = "a".repeat(40);

test("contained published recovery reuses the advanced channel version state", () => {
  const updates = [];
  const context = {
    advancedChannelSha: SHA,
    advancedPublicationTransaction: {
      state: "finalizing",
      version: "4.0.1",
    },
    cwd: "/unused",
    discoverVersionStateFiles: () => ({
      files: [
        { path: "package.json" },
        { path: "dist/site/site-manifest.json" },
      ],
    }),
    requireVersionState: true,
    rule: { channel: "release" },
    updates,
    versionVerificationAllowedPathsForPromotion: (_channel, files) => files,
  };
  const state = { containsPublishedMaterial: true };
  const result = containedPublishedVersionState(context, state, "4.0.1");
  assert.equal(result.releaseCommit.sha, SHA);
  assert.equal(result.releaseCommit.action, "existing-recovered-published");
  assert.equal(updates[0].action, "existing-recovered-published-version-state");
  assert.throws(
    () => containedPublishedVersionState(context, state, "4.0.2"),
    /not bound to the advanced channel transaction/,
  );
});

test("ordinary publication keeps using version-state creation", () => {
  assert.equal(
    containedPublishedVersionState(
      {
        advancedChannelSha: SHA,
        advancedPublicationTransaction: {
          state: "finalizing",
          version: "4.0.1",
        },
      },
      { containsPublishedMaterial: false },
      "4.0.1",
    ),
    undefined,
  );
});

test("contained recovery keeps the sealed release candidate version", () => {
  const context = {
    releaseCandidateValidation: { recoveredCandidate: true },
    releaseCandidateVersion: "4.0.1-alpha.56",
  };
  const state = {
    containsPublishedMaterial: true,
    releaseVersion: "4.0.1",
  };
  assert.equal(
    containedPublishedReleaseCandidateVersion(context, state, "4.0.1-alpha.57"),
    "4.0.1-alpha.56",
  );
  assert.throws(
    () =>
      containedPublishedReleaseCandidateVersion(
        { ...context, releaseCandidateVersion: "4.0.2-alpha.0" },
        state,
        "4.0.1-alpha.57",
      ),
    /is not bound to release 4\.0\.1/u,
  );
  assert.equal(
    containedPublishedReleaseCandidateVersion(
      context,
      { ...state, containsPublishedMaterial: false },
      "4.0.1-alpha.57",
    ),
    "4.0.1-alpha.57",
  );
});
