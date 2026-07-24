import assert from "node:assert/strict";
import test from "node:test";

import { validatePublicationCommitEvidence } from "../scripts/publication-commit-evidence.mjs";

const SOURCE_SHA = "1".repeat(40);
const RELEASE_SHA = "2".repeat(40);
const ROOT = `sha256:${"a".repeat(64)}`;

function fixture() {
  return {
    schema: "kungfu-buildchain-publication-commit-evidence/v1",
    status: "passed",
    identity: {
      version: "4.0.0-alpha.2",
      sourceSha: SOURCE_SHA,
      releaseSha: RELEASE_SHA,
      releaseTag: "v4.0.0-alpha.2",
    },
    publication: {
      url: "https://kungfu.tech/.well-known/kungfu/alpha.json",
      payloadRoot: ROOT,
    },
    readback: {
      status: "passed",
      url: "https://kungfu.tech/.well-known/kungfu/alpha.json",
      payloadRoot: ROOT,
    },
    recovery: {
      previousAuthority: "preserved",
      rollbackReference: "sha256:previous",
    },
  };
}

const expected = {
  version: "4.0.0-alpha.2",
  sourceSha: SOURCE_SHA,
  releaseSha: RELEASE_SHA,
  releaseTag: "v4.0.0-alpha.2",
};

test("publication commit evidence binds exact public read-back", () => {
  const result = validatePublicationCommitEvidence(fixture(), expected);
  assert.equal(result.status, "passed");
  assert.equal(result.payloadRoot, ROOT);
});

test("publication commit evidence rejects stale or unrooted authority", () => {
  const stale = fixture();
  stale.readback.payloadRoot = `sha256:${"b".repeat(64)}`;
  assert.throws(
    () => validatePublicationCommitEvidence(stale, expected),
    /exact payload root/,
  );

  const drifted = fixture();
  drifted.identity.releaseSha = "3".repeat(40);
  assert.throws(
    () => validatePublicationCommitEvidence(drifted, expected),
    /releaseSha mismatch/,
  );

  const unrecoverable = fixture();
  unrecoverable.recovery.rollbackReference = "";
  assert.throws(
    () => validatePublicationCommitEvidence(unrecoverable, expected),
    /rollbackReference is required/,
  );
});
