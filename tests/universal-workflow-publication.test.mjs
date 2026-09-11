import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { admitUniversalWorkflow, selectFinalizedProductPublicationVersion, selectRecoveredProductPublicationVersion, productStateVersion, universalWorkflowAdmissionRoot } from "../packages/core/workflow/universal-workflow-bootstrap.js";
import { sha, policy, request, runtime, consumerObservation } from "./universal-workflow-harness.mjs";

test("real universal promotion materializes one rooted product intent before APPLY", () => {
  const engine = fs.readFileSync(
    new URL(
      "../packages/core/workflow/engine/release-promotion.js",
      import.meta.url,
    ),
    "utf8",
  );
  const intent = engine.indexOf("await materializeProductPublicationIntent(");
  const apply = engine.indexOf(
    "await promoteReleaseCandidate(publicationRequest",
  );
  assert.ok(intent >= 0 && apply > intent);
  assert.match(
    engine,
    /"product-publication-intent-path": productPublicationIntentPath/u,
  );
  assert.match(
    engine,
    /"resume-transaction-id": payload\.inputs\["resume-transaction-id"\]/u,
  );
  assert.match(engine, /sourceTimestamp,[\s\S]*manifestPath: candidate.paths.sealedBundleManifest,[\s\S]*requiredArtifactsPath: candidate.paths.publishRequiredArtifacts/u);
  assert.match(engine, /candidateVersion: version,[\s\S]*recoveredVersion,[\s\S]*fs.readFileSync\(productPublicationIntentPath\),[\s\S]*version: productPublicationIntent.version,\s*tag: productPublicationIntent.exactTag/u);
  const version = "4.0.2-alpha.11",
    candidateVersion = "4.0.2-alpha.10",
    sourceSha = sha("4"),
    recovery = { candidateVersion, requestedSha: sourceSha };
  assert.equal(
    selectRecoveredProductPublicationVersion({
      ...recovery,
      routeDecision: "Fresh",
    }),
    "",
  );
  const state = (selected, character = "5") => ({
    stateRef: {
      ref: `refs/heads/buildchain/v4-product-state/${sourceSha}-${selected.replaceAll(".", "-")}`,
      object: { type: "commit", sha: sha(character) },
    },
    stateCommit: { sha: sha(character), parents: [{ sha: sourceSha }] },
    exactTagRef: {
      ref: `refs/tags/v${selected}`,
      object: { type: "commit", sha: sourceSha },
    },
  });
  assert.equal(
    productStateVersion(state(version).stateRef, sourceSha),
    version,
  );
  assert.equal(
    selectRecoveredProductPublicationVersion({
      ...recovery,
      routeDecision: "Resume",
      recoveryStates: [state(version, "6")],
    }),
    version,
  );
  assert.throws(
    () =>
      selectRecoveredProductPublicationVersion({
        ...recovery,
        routeDecision: "Resume",
        recoveryStates: [state(candidateVersion), state(version, "6")],
      }),
    { code: "recovery-state-ambiguous" },
  );
  assert.equal(
    selectRecoveredProductPublicationVersion({
      ...recovery,
      routeDecision: "Resume",
      recoveryStates: [{ ...state(version), exactTagRef: undefined }],
    }),
    version,
  );
  assert.equal(
    selectRecoveredProductPublicationVersion({
      ...recovery,
      routeDecision: "Resume",
      explicitResume: true,
    }),
    candidateVersion,
  );
  assert.equal(
    selectRecoveredProductPublicationVersion({
      ...recovery,
      candidateVersion: version,
      routeDecision: "Resume",
      exactTagRef: {
        ref: `refs/tags/v${version}`,
        object: { type: "commit", sha: sourceSha },
      },
    }),
    version,
  );
  assert.throws(
    () =>
      selectRecoveredProductPublicationVersion({
        ...recovery,
        routeDecision: "Resume",
      }),
    { code: "recovery-tag-missing" },
  );
  assert.throws(
    () =>
      selectRecoveredProductPublicationVersion({
        ...recovery,
        routeDecision: "Resume",
        recoveryStates: [
          {
            ...state(version),
            stateCommit: { sha: sha("5"), parents: [{ sha: sha("7") }] },
          },
        ],
      }),
    { code: "recovery-state-mismatch" },
  );
  assert.throws(
    () =>
      selectRecoveredProductPublicationVersion({
        ...recovery,
        routeDecision: "Resume",
        recoveryStates: [
          {
            ...state(version),
            exactTagRef: {
              ref: `refs/tags/v${version}`,
              object: { type: "commit", sha: sha("7") },
            },
          },
        ],
      }),
    { code: "recovery-tag-mismatch" },
  );
});

test("generated product-state finalization heads are semantic no-ops", () => {
  const sourceSha = sha("3"),
    stateSha = sha("4"),
    headSha = sha("5"),
    treeSha = sha("6");
  const state = {
    stateRef: {
      ref: `refs/heads/buildchain/v4-product-state/${sourceSha}-4-0-2-alpha-16`,
      object: { type: "commit", sha: stateSha },
    },
    stateCommit: {
      sha: stateSha,
      tree: { sha: treeSha },
      parents: [{ sha: sourceSha }],
    },
    exactTagRef: {
      ref: "refs/tags/v4.0.2-alpha.16",
      object: { type: "commit", sha: sourceSha },
    },
    headComparisonStatus: "ahead",
  };
  assert.equal(
    selectFinalizedProductPublicationVersion({
      requestedSha: headSha,
      requestedTree: treeSha,
      targetRef: "alpha/v4/v4.0",
      recoveryStates: [state],
    }),
    "4.0.2-alpha.16",
  );
  assert.equal(
    selectFinalizedProductPublicationVersion({
      requestedSha: sourceSha,
      requestedTree: sha("7"),
      targetRef: "alpha/v4/v4.0",
      recoveryStates: [state],
    }),
    "",
  );
  assert.throws(
    () =>
      selectFinalizedProductPublicationVersion({
        requestedSha: headSha,
        requestedTree: treeSha,
        targetRef: "alpha/v4/v4.0",
        recoveryStates: [
          state,
          {
            ...state,
            stateRef: {
              ref: `refs/heads/buildchain/v4-product-state/${sourceSha}-4-0-2-alpha-17`,
              object: { type: "commit", sha: sha("8") },
            },
            stateCommit: {
              sha: sha("8"),
              tree: { sha: treeSha },
              parents: [{ sha: sourceSha }],
            },
            exactTagRef: undefined,
          },
        ],
      }),
    { code: "finalization-state-ambiguous" },
  );
});

test("production admission rejects contract-only false success", () => {
  const policyValue = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/universal-workflow-capability-policy.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    policyValue.allowedCapabilities.includes("workflow-contract"),
    false,
  );
  const requestValue = request(policyValue);
  requestValue.capability.id = "workflow-contract";
  requestValue.capability.contractRoots = policyValue.contractRoots;
  assert.throws(
    () =>
      admitUniversalWorkflow({
        ...consumerObservation(),
        request: requestValue,
        policy: policyValue,


        now: "2026-08-30T12:00:00.000Z",
      }),
    { code: "capability-not-admitted" },
  );
});

test("Bootstrap preserves caller permissions and retains evidence in its terminal node", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/public-ops-bootstrap.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    workflow.slice(0, workflow.indexOf("\njobs:")),
    /^permissions:/mu,
  );
  const topology = parseYaml(workflow);
  for (const [name, job] of Object.entries(topology.jobs)) {
    if (name !== "execution-runtime") assert.equal(job.permissions, undefined);
  }
  assert.ok(
    topology.jobs.settle.steps.some((step) =>
      step.uses?.endsWith("/actions/workflow/bootstrap/settle"),
    ),
  );
  const terminal = parseYaml(
    fs.readFileSync(
      new URL(
        "../actions/workflow/bootstrap/settle/action.yml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const upload = terminal.runs.steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.ok(upload.with.path.includes(".buildchain/terminal-receipt.json"));
  assert.ok(!upload.with.path.includes(".buildchain/backflow.json"));
});
