import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_ACTIVATION_PHASES,
  abortReleaseActivationTransaction,
  createReleaseActivationReceiptSet,
  createReleaseActivationTransaction,
  recordReleaseActivationPhase,
  releaseActivationRoot,
  rollbackReleaseActivationTransaction,
  validateReleaseActivationReceiptSet,
  validateReleaseActivationTransaction,
} from "../packages/core/release-activation-transaction.js";

const root = (character) => `sha256:${character.repeat(64)}`;
const binding = {
  sourceSha: "a".repeat(40),
  siteSourceSha: "b".repeat(40),
  tag: "v4.0.0-alpha.1",
  channel: "alpha",
  version: "4.0.0-alpha.1",
  environment: "shadow",
  artifactSetRoot: root("1"),
};
const owners = {
  product: "kungfu-systems/kungfu",
  transaction: "kungfu-systems/buildchain",
  site: "kungfu-systems/site-kungfu-tech",
};

function completeShadow() {
  let transaction = createReleaseActivationTransaction({
    transactionId: "shadow-alpha-1",
    bindings: binding,
    owners,
  });
  RELEASE_ACTIVATION_PHASES.forEach((phase, index) => {
    transaction = recordReleaseActivationPhase(transaction, phase, {
      receiptRoots: [root(String(index + 2))],
    });
  });
  return transaction;
}

test("shadow activation preserves order and never claims released use", () => {
  const transaction = completeShadow();
  assert.equal(transaction.state, "complete");
  assert.equal(transaction.releasedUseClaim, false);
  assert.equal(validateReleaseActivationTransaction(transaction).valid, true);
});

test("activation fails closed on skipped phase and changed replay roots", () => {
  const transaction = createReleaseActivationTransaction({
    transactionId: "shadow-alpha-1",
    bindings: binding,
    owners,
  });
  assert.throws(
    () =>
      recordReleaseActivationPhase(transaction, "site-published", {
        receiptRoots: [root("a")],
      }),
    /cannot skip/,
  );
  const qualified = recordReleaseActivationPhase(
    transaction,
    "candidate-qualified",
    {
      receiptRoots: [root("2")],
    },
  );
  assert.throws(
    () =>
      recordReleaseActivationPhase(qualified, "candidate-qualified", {
        receiptRoots: [root("3")],
      }),
    /replay changed/,
  );
});

test("receipt synthesis requires five exact receipt bindings", () => {
  const transaction = completeShadow();
  const bindingRoot = releaseActivationRoot(transaction.bindings);
  const kinds = [
    "artifact-publication",
    "release-passport",
    "site-publication",
    "public-readback",
    "product-qualification",
  ];
  const receiptRootCharacters = ["7", "8", "9", "a", "b"];
  const receiptSet = createReleaseActivationReceiptSet({
    transaction,
    receipts: kinds.map((kind, index) => ({
      kind,
      root: root(receiptRootCharacters[index]),
      bindingRoot,
      locator: `.buildchain/activation/${kind}.json`,
    })),
  });
  assert.equal(receiptSet.releasedUseClaim, false);
  assert.equal(validateReleaseActivationReceiptSet(receiptSet).valid, true);
  assert.equal(
    validateReleaseActivationReceiptSet(receiptSet, { allowShadow: false })
      .valid,
    false,
  );
  assert.throws(
    () =>
      createReleaseActivationReceiptSet({
        transaction,
        receipts: kinds.slice(1).map((kind, index) => ({
          kind,
          root: root(receiptRootCharacters[index]),
          bindingRoot,
          locator: kind,
        })),
      }),
    /missing artifact-publication/,
  );
});

test("partial failure, retry, abort, and rollback remain explicit", () => {
  let transaction = createReleaseActivationTransaction({
    transactionId: "shadow-alpha-2",
    bindings: binding,
    owners,
  });
  transaction = recordReleaseActivationPhase(
    transaction,
    "candidate-qualified",
    {
      receiptRoots: [root("2")],
    },
  );
  transaction = recordReleaseActivationPhase(
    transaction,
    "artifacts-published",
    {
      failure: "public artifact readback was stale",
    },
  );
  assert.equal(transaction.phases[1].status, "failed");
  transaction = recordReleaseActivationPhase(
    transaction,
    "artifacts-published",
    {
      receiptRoots: [root("3")],
    },
  );
  assert.equal(transaction.phases[1].attempts, 2);
  const aborted = abortReleaseActivationTransaction(
    transaction,
    "operator stopped shadow",
  );
  assert.equal(aborted.state, "aborted");
  const rolledBack = rollbackReleaseActivationTransaction(aborted, {
    toSiteSourceSha: "c".repeat(40),
    reason: "restore previous reviewed site source",
  });
  assert.equal(rolledBack.state, "rolled-back");
});
