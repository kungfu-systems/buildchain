import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createGithubProductAdapters } from "../packages/core/release/promote-candidate/product-provider-github-adapters.js";
import { selectRecoveredProductPublicationVersion } from "../packages/core/workflow/universal-workflow-bootstrap.js";

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

test("publication coordinates retain the exact tag after the channel advances", async () => {
  for (const channel of ["stable", "alpha"]) {
    const version = channel === "stable" ? "4.0.2" : "4.0.2-alpha.44";
    const targetRef = `${channel === "stable" ? "release" : channel}/v4/v4.0`;
    const refs = new Map([
      [`heads/${targetRef}`, stateSha],
      [`tags/v${version}`, sourceSha],
    ]);
    const runtime = createGithubProductAdapters({
      intent: {
        repository: "kungfu-systems/buildchain",
        targetRef,
        exactTag: `v${version}`,
      },
      request: {
        octokit: {
          rest: {
            git: {
              async getRef({ ref }) {
                if (!refs.has(ref))
                  throw Object.assign(new Error("not found"), { status: 404 });
                return { data: { object: { sha: refs.get(ref) } } };
              },
            },
          },
        },
      },
    });
    assert.equal(await runtime.resolveReleaseSha(), sourceSha);
    assert.equal(await runtime.resolvePromotedSha(), stateSha);
    refs.delete(`tags/v${version}`);
    assert.equal(await runtime.resolveReleaseSha(), "");
    assert.equal(await runtime.resolvePromotedSha(), stateSha);
    refs.delete(`heads/${targetRef}`);
    assert.equal(await runtime.resolvePromotedSha(), "");
  }
});

test("stable recovery uses the published stable version of an exact alpha candidate", () => {
  assert.equal(
    selectRecoveredProductPublicationVersion({
      ...recovery,
      recoveryStates: [state()],
    }),
    "4.0.2",
  );
  assert.equal(
    selectRecoveredProductPublicationVersion({
      ...recovery,
      exactTagRef: state().exactTagRef,
    }),
    "4.0.2",
  );
  assert.equal(
    selectRecoveredProductPublicationVersion({
      ...recovery,
      explicitResume: true,
    }),
    "4.0.2",
  );
  const engine = fs.readFileSync(
    new URL("../packages/core/workflow/commands/universal-workflow-engine.mjs", import.meta.url),
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
        selectRecoveredProductPublicationVersion({
          ...recovery,
          recoveryStates: [row],
        }),
      { code: "recovery-state-mismatch" },
    );
  assert.throws(
    () =>
      selectRecoveredProductPublicationVersion({
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
      selectRecoveredProductPublicationVersion({
        ...recovery,
        channel: "alpha",
        recoveryStates: [state()],
      }),
    { code: "recovery-state-mismatch" },
  );
  assert.equal(
    selectRecoveredProductPublicationVersion({
      ...recovery,
      channel: "alpha",
      recoveryStates: [state("4.0.2-alpha.45")],
    }),
    "4.0.2-alpha.45",
  );
});
