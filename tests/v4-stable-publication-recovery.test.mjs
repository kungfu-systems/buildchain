import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { selectV4RecoveredProductPublicationVersion } from "../packages/core/v4-universal-workflow-bootstrap.js";

const sourceSha = "4".repeat(40);
const stateSha = "5".repeat(40);
const state = (version = "4.0.2") => ({
  stateRef: {
    ref: `refs/heads/buildchain/v4-product-state/${sourceSha}-${version.replaceAll(".", "-")}`,
    object: { type: "commit", sha: stateSha },
  },
  stateCommit: { sha: stateSha, parents: [{ sha: sourceSha }] },
  exactTagRef: {
    ref: `refs/tags/v${version}`,
    object: { type: "commit", sha: sourceSha },
  },
});
const recovery = {
  routeDecision: "Resume",
  candidateVersion: "4.0.2-alpha.44",
  channel: "stable",
  requestedSha: sourceSha,
};

test("stable recovery uses the published stable version of an exact alpha candidate", () => {
  assert.equal(
    selectV4RecoveredProductPublicationVersion({
      ...recovery,
      recoveryStates: [state()],
    }),
    "4.0.2",
  );
  assert.equal(
    selectV4RecoveredProductPublicationVersion({
      ...recovery,
      exactTagRef: state().exactTagRef,
    }),
    "4.0.2",
  );
  assert.equal(
    selectV4RecoveredProductPublicationVersion({
      ...recovery,
      explicitResume: true,
    }),
    "4.0.2",
  );
  const engine = fs.readFileSync(
    new URL("../scripts/v4-universal-workflow-engine.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    engine,
    /observeProductPublicationRecovery\(repository, route\.requestedSha, version, route\.channel\)/u,
  );
  assert.match(engine, /candidateVersion: version, channel: route\.channel/u);
});

test("stable recovery retains patch, source and exact-tag rejection boundaries", () => {
  for (const row of [
    state("4.0.3"),
    {
      ...state(),
      stateCommit: { sha: stateSha, parents: [{ sha: "6".repeat(40) }] },
    },
  ])
    assert.throws(
      () =>
        selectV4RecoveredProductPublicationVersion({
          ...recovery,
          recoveryStates: [row],
        }),
      { code: "recovery-state-mismatch" },
    );
  assert.throws(
    () =>
      selectV4RecoveredProductPublicationVersion({
        ...recovery,
        recoveryStates: [
          {
            ...state(),
            exactTagRef: {
              ref: "refs/tags/v4.0.2",
              object: { type: "commit", sha: "6".repeat(40) },
            },
          },
        ],
      }),
    { code: "recovery-tag-mismatch" },
  );
  assert.throws(
    () =>
      selectV4RecoveredProductPublicationVersion({
        ...recovery,
        channel: "alpha",
        recoveryStates: [state()],
      }),
    { code: "recovery-state-mismatch" },
  );
  assert.equal(
    selectV4RecoveredProductPublicationVersion({
      ...recovery,
      channel: "alpha",
      recoveryStates: [state("4.0.2-alpha.45")],
    }),
    "4.0.2-alpha.45",
  );
});
