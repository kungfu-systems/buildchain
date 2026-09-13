import test from "node:test";
import assert from "node:assert/strict";
import { identities } from "./helpers/business-attempt.mjs";
import { journalSnapshot } from "../packages/core/workflow/attempt/journal.js";
import {
  guardPipelineDelivery,
  validatePipelineExecutionRequest,
} from "../packages/core/workflow/pipeline/guard.js";

test("delivery effects cannot change the retained native command or borrow another provider execution", () => {
  const f = identities();
  const observed = { attempt: f.attempt.id, generation: f.generation.id };
  const coordinates = { runId: 100, runAttempt: 1 };
  const request = {
    "pipeline-attempt": f.attempt.id,
    "native-command": "node owned-build.mjs",
  };
  const execution = {
    schema: "buildchain.pipeline-delivery-execution/v1",
    ...observed,
    ...coordinates,
    request,
  };
  validatePipelineExecutionRequest(execution, request, observed, coordinates);
  assert.throws(
    () =>
      validatePipelineExecutionRequest(
        execution,
        { ...request, "native-command": "true" },
        observed,
        coordinates,
      ),
    /retained request field/,
  );
  assert.throws(
    () =>
      validatePipelineExecutionRequest(execution, request, observed, {
        ...coordinates,
        runAttempt: 2,
      }),
    /exact admitted/,
  );
});

test("credentialed delivery guard rejects stopped or mismatched attempt before provider mutation", async () => {
  const f = identities();
  const root = f.event();
  let snapshot = journalSnapshot(f.intent, [root]);
  const lookup = {
    resolve: async (attempt) => {
      assert.equal(attempt, f.attempt.id);
      return { snapshot };
    },
  };
  const input = {
    "pipeline-attempt": f.attempt.id,
    "target-branch": f.intent.source.targetBranch,
    "expected-pr-number": 23,
    "expected-head-sha": f.source.commit,
  };
  const connection = {
    repository: f.intent.repository,
    token: "test-scoped-read",
  };
  assert.equal(
    (await guardPipelineDelivery(input, connection, lookup)).attempt,
    f.attempt.id,
  );
  await assert.rejects(
    guardPipelineDelivery(
      { ...input, "expected-head-sha": "f".repeat(40) },
      connection,
      lookup,
    ),
    /admitted source intent/,
  );
  snapshot = journalSnapshot(f.intent, [
    root,
    f.event(root, {
      state: "waiting",
      reason: "pipeline-stop-requested:closed",
    }),
  ]);
  await assert.rejects(
    guardPipelineDelivery(input, connection, lookup),
    /requested stop/,
  );
  await assert.rejects(
    guardPipelineDelivery(input, { ...connection, token: "" }, lookup),
    /scoped read credential/,
  );
  assert.equal(await guardPipelineDelivery({}, {}), null);
});
