import assert from "node:assert/strict";
import test from "node:test";
import { stableBaselineFixture } from "./helpers/pipeline-stable-baseline.mjs";
import { readPipelineStableBaseline } from "../packages/core/providers/github/pipeline-stable-baseline.js";
import { releaseTailRoot } from "../packages/core/release/release-tail-provider-plane.js";
import { createReleaseReceipt } from "../packages/core/release/release-invocation.js";

const read = (f) =>
  readPipelineStableBaseline(f.plan, f.host, f.release, f.prior);
function resealProduct(f) {
  const d = f.settlement.documents,
    oldRoot = d.product.root;
  const { root, ...body } = d.product;
  d.product.root = releaseTailRoot(body);
  const { receiptRoot, ...receipt } = d.receipt;
  receipt.providerReceiptRoots = receipt.providerReceiptRoots
    .map((value) => (value === oldRoot ? d.product.root : value))
    .sort();
  const sealed = createReleaseReceipt(receipt);
  d.receipt = { ...sealed.receipt, receiptRoot: sealed.receiptRoot };
  f.encode();
}

test("legacy completed settlement binds exact product source and separately promoted floating entry", async () => {
  const f = await stableBaselineFixture(),
    result = await read(f);
  assert.equal(result.sourceSha, f.prior.commit);
  assert.equal(result.channelCommit, f.plan.previousChannelCommit);
  assert.equal(result.channelRef, "refs/tags/v1");
  assert.equal(result.receiptRoot, f.settlement.documents.receipt.receiptRoot);
  assert.deepEqual(
    result.assets,
    f.assets.map(({ state, ...asset }) => asset),
  );
  assert.equal(f.calls.length, 2);
});

test("ordinary and first publications need no legacy evidence reads", async () => {
  const f = await stableBaselineFixture();
  f.plan.previousChannelCommit = f.prior.commit;
  assert.equal(await read(f), null);
  f.plan.previousChannelCommit = null;
  f.prior = null;
  f.release = null;
  assert.equal(await read(f), null);
  assert.equal(f.calls.length, 0);
});

test("missing, duplicate, truncated or changed provider evidence cannot bridge a channel mismatch", async () => {
  const cases = [
    (f) => {
      f.assets.pop();
    },
    (f) => {
      f.assets.push({ ...f.assets[0] });
    },
    (f) => {
      f.assets[0].state = "new";
    },
    (f) => {
      f.assets[0].size = 9 * 1024 * 1024;
    },
    (f) => {
      delete f.assets[0].digest;
    },
    (f) => {
      f.downloads.set(f.assets[0].id, Buffer.from("{}"));
    },
    (f) => {
      const original = f.host.request;
      f.host.request = async (...args) => {
        if (f.calls.length) f.assets[0].digest = `sha256:${"0".repeat(64)}`;
        return original(...args);
      };
    },
  ];
  for (const mutate of cases) {
    const f = await stableBaselineFixture();
    mutate(f);
    await assert.rejects(read(f));
  }
});

test("exact release, public passport, completed lineage and channel identity are all required", async () => {
  const cases = [
    (f) => {
      f.settlement.release.sourceSha = "a".repeat(40);
    },
    (f) => {
      f.settlement.release.tag = "v1.0.1";
    },
    (f) => {
      f.settlement.release.channel = "alpha";
    },
    (f) => {
      f.settlement.documents.invocation.provider.repository = "foreign/product";
    },
    (f) => {
      f.settlement.documents.providerState.state = "failed";
    },
    (f) => {
      f.settlement.documents.productState.state = "failed";
    },
    (f) => {
      f.documents["buildchain.release.json"] = {};
    },
    (f) => {
      f.plan.previousChannelCommit = "9".repeat(40);
    },
    (f) => {
      f.settlement.documents.receipt.receiptRoot = `sha256:${"0".repeat(64)}`;
    },
  ];
  for (const mutate of cases) {
    const f = await stableBaselineFixture();
    mutate(f);
    f.encode();
    await assert.rejects(read(f));
  }
});

test("even internally sealed product evidence must name exactly one matching floating update", async () => {
  const cases = [
    (p) => {
      p.promotedSha = "a".repeat(40);
    },
    (p) => {
      p.updates = [];
    },
    (p) => {
      p.updates.push({ ...p.updates[0] });
    },
    (p) => {
      p.updates[0].action = "pending-protected-ref-pr";
    },
    (p) => {
      p.updates[0].ref = "refs/tags/v1-alpha";
    },
    (p) => {
      p.updates[0].sha = "a".repeat(40);
    },
  ];
  for (const mutate of cases) {
    const f = await stableBaselineFixture();
    mutate(f.settlement.documents.product);
    resealProduct(f);
    await assert.rejects(
      read(f),
      /does not bind the retained floating channel/,
    );
  }
});
