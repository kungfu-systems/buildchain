import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicationSettlementFixture } from "./helpers/publication-settlement.mjs";
import { createReleaseReceipt } from "../packages/core/release/release-invocation.js";
import { releaseTailRoot } from "../packages/core/release/release-tail-provider-plane.js";
import {
  settlePublication,
  SETTLEMENT_ASSET,
} from "../packages/core/publication/commands/publication-settlement.mjs";

const original = (await publicationSettlementFixture()).documents;
const repository = original.invocation.candidate.repository;
const candidateSha = original.invocation.candidate.commit;
const release = {
  sourceSha: original.product.publication.releaseSha,
  tag: original.invocation.target.tag,
  channel: original.invocation.target.channel,
};
const packet = {
  schemaVersion: 1,
  contract: "buildchain-v4-publication-settlement/v1",
  id: "v4-publication",
  release,
  documents: original,
};
const paths = {
  invocation: "release-tail/release-invocation.json",
  transaction: "release-tail/release-transaction.json",
  receipt: "release-tail/release-receipt.json",
  product: "release-tail/product-provider-result.json",
  providerState: "release-tail/state.json",
  productState: "release-tail/product-provider-transaction.json",
  passport: "release-passport/buildchain.release.json",
};

function fixture(
  t,
  { retained = packet, local = original, duplicate = false } = {},
) {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-settlement-test-"),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  };
  for (const [key, file] of Object.entries(paths))
    write(path.join(base, file), local[key]);
  let uploads = 0;
  const client = {
    release: () => ({
      assets: [
        { name: "buildchain.release.json" },
        ...(retained ? [{ name: SETTLEMENT_ASSET }] : []),
        ...(duplicate ? [{ name: SETTLEMENT_ASSET }] : []),
      ],
    }),
    json: () => ({ sha: release.sourceSha }),
    assetBytes: ({ name }) =>
      JSON.stringify(name === SETTLEMENT_ASSET ? retained : original.passport),
    write,
    publish: async () => {
      assert.equal(
        retained,
        null,
        "immutable publication packet must not be uploaded again",
      );
      uploads++;
    },
  };
  return {
    input: { base, client, repository, candidateSha, applyOutcome: "pending" },
    uploads: () => uploads,
  };
}

test("recovery retains the original complete receipt when local recovery observations differ", async (t) => {
  const local = structuredClone(original);
  const { receiptRoot: _root, ...body } = local.receipt;
  // Model an additional provider observation in a later recovery execution.
  body.providerReceiptRoots = [
    ...body.providerReceiptRoots,
    releaseTailRoot({ fixture: "recovery-observation" }),
  ].sort();
  const created = createReleaseReceipt(body);
  local.receipt = { ...created.receipt, receiptRoot: created.receiptRoot };
  assert.notEqual(local.receipt.receiptRoot, original.receipt.receiptRoot);
  const { input, uploads } = fixture(t, { local });
  const result = await settlePublication(input);
  assert.equal(result.receipt.receiptRoot, original.receipt.receiptRoot);
  assert.equal(result.summary.receiptRoot, original.receipt.receiptRoot);
  assert.equal(result.summary.nextDevelopment, "incomplete");
  assert.equal(uploads(), 0);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(input.base, "release-tail", SETTLEMENT_ASSET)),
    ),
    packet,
  );
  assert.equal(
    (await settlePublication(input)).receipt.receiptRoot,
    original.receipt.receiptRoot,
  );
  assert.equal(uploads(), 0);
});

test("first settlement still publishes and verifies the new complete packet", async (t) => {
  const { input, uploads } = fixture(t, { retained: null });
  assert.equal(
    (await settlePublication(input)).receipt.receiptRoot,
    original.receipt.receiptRoot,
  );
  assert.equal(uploads(), 1);
});

test("retained settlement rejects ambiguity, tampering and mismatched identity", async (t) => {
  for (const mutation of [
    (value) => {
      value.contract = "other";
    },
    (value) => {
      value.release.sourceSha = "a".repeat(40);
    },
    (value) => {
      value.release.tag = "v0.0.0";
    },
    (value) => {
      value.release.channel = "stable";
    },
    (value) => {
      value.documents.receipt.receiptRoot = "sha256:" + "a".repeat(64);
    },
    (value) => {
      value.documents.invocation.candidate.commit = "a".repeat(40);
    },
  ]) {
    const retained = structuredClone(packet);
    mutation(retained);
    const { input, uploads } = fixture(t, { retained });
    await assert.rejects(settlePublication(input));
    assert.equal(uploads(), 0);
  }
  await assert.rejects(
    settlePublication(fixture(t, { duplicate: true }).input),
    /ambiguous/u,
  );
});

test("valid retained evidence cannot hide an invalid current execution", async (t) => {
  const local = structuredClone(original);
  local.receipt.outcome = "failed";
  const { input, uploads } = fixture(t, { local });
  await assert.rejects(settlePublication(input));
  assert.equal(uploads(), 0);
});
