import test from "node:test";
import assert from "node:assert/strict";
import { publicationRecoveryFixture } from "./helpers/pipeline-publication-recovery.mjs";
import {
  createRecoveryPublicationAdmission,
  verifyRecoveryPublicationAdmission,
} from "../packages/core/publication/pipeline/recovery-admission.js";
import { observeRecoveryPublicationEffects } from "../packages/core/publication/pipeline/recovery-readback.js";
import { verifyPipelineQualification } from "../packages/core/publication/pipeline/documents.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

test("fresh recovery admission retains expired historical documents and binds the repaired publisher and runtime through Rust lineage", async () => {
  const f = publicationRecoveryFixture();
  const before = structuredClone(f.retained);
  assert.throws(
    () =>
      verifyPipelineQualification({
        ...f.context,
        qualified: f.retained.qualified,
        evaluatedAt: f.now.toISOString(),
      }),
    /freshness window/,
  );
  const readback = await observeRecoveryPublicationEffects({
    effects: [f.effect],
    receipts: [],
    retained: f.retained,
    provider: {
      observe: async () => ({ state: "absent" }),
      matches: () => false,
    },
    fence: async () => {},
  });
  const input = { ...f, readback };
  const admission = createRecoveryPublicationAdmission(input);
  verifyRecoveryPublicationAdmission(admission, input);
  assert.equal(
    admission.invocation.invocation.parent.transactionRoot,
    f.retained.documents.transaction.transactionRoot,
  );
  assert.equal(
    admission.invocation.invocation.runtime.commit,
    f.execution.runtime.commit,
  );
  assert.equal(
    admission.invocation.invocation.publisher.workflowSha,
    f.execution.publisher.workflowSha,
  );
  assert.equal(admission.predecessorReceipt.receipt.outcome, "blocked");
  assert.notEqual(
    admission.qualification.receiptRoot,
    f.retained.qualified.qualification.receiptRoot,
  );
  assert.deepEqual(f.retained, before);
  assert.throws(
    () =>
      verifyRecoveryPublicationAdmission(admission, {
        ...input,
        now: new Date(f.now.getTime() + 3600000),
      }),
    /freshness window/,
  );
  assert.throws(
    () =>
      verifyRecoveryPublicationAdmission(admission, {
        ...input,
        execution: { ...f.execution, runId: 201 },
      }),
    /exact current execution/,
  );
  assert.throws(
    () =>
      verifyRecoveryPublicationAdmission(admission, {
        ...input,
        context: {
          ...f.context,
          recovery: {
            ...f.context.recovery,
            planRoot: recordDigest("changed"),
          },
        },
      }),
    /exact execution/,
  );
});

test("provider requalification detects changed completed bytes and forged prior transaction receipts without effects", async () => {
  const f = publicationRecoveryFixture();
  const body = {
    schema: "buildchain.pipeline-publication-effect/v1",
    effectId: f.effect.id,
    effectRoot: f.effect.root,
    transactionRoot: f.retained.documents.transaction.transactionRoot,
    state: "success",
    observed: { state: "present", commit: f.effect.commit },
  };
  const receipt = { ...body, root: recordDigest(body) };
  const input = {
    effects: [f.effect],
    receipts: [receipt],
    retained: f.retained,
    fence: async () => {},
    provider: {
      observe: async () => ({ state: "absent" }),
      matches: () => false,
      apply: () => assert.fail("readback cannot publish"),
    },
  };
  await assert.rejects(
    observeRecoveryPublicationEffects(input),
    /conflicts with retained bytes/,
  );
  await assert.rejects(
    observeRecoveryPublicationEffects({
      ...input,
      receipts: [{ ...receipt, transactionRoot: recordDigest("other") }],
    }),
    /rewrite a prior/,
  );
  input.provider.observe = async () => body.observed;
  input.provider.matches = (effect, value) => effect.commit === value.commit;
  const readback = await observeRecoveryPublicationEffects(input);
  assert.equal(readback.observations[0].matched, true);
  assert.deepEqual(readback.receiptRoots, [receipt.root]);
});
