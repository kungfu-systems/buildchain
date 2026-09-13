import test from "node:test";
import assert from "node:assert/strict";
import { distributePipelineProducts } from "../packages/core/publication/pipeline/distribution.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

test("distribution preserves publication success, reconciles a lost channel response and never republishes products", async () => {
  const old = "a".repeat(40),
    commit = "b".repeat(40);
  let observed = old,
    writes = 0,
    fail = true;
  const publication = { receiptRoot: recordDigest("published exact bytes") };
  const records = [{ id: "publication/complete/root", value: publication }];
  const journal = {
    fence: async () => {},
    materials: async (prefix) =>
      records
        .filter(({ id }) => id.startsWith(prefix))
        .map(({ value }) => structuredClone(value)),
    record: async (id, value) =>
      records.push({
        id: `${id}/${recordDigest(value)}`,
        value: structuredClone(value),
      }),
  };
  const host = {
    repository: "example/product",
    request: async (url, options = {}) => {
      if (options.method === "PATCH") {
        writes++;
        assert.equal(options.body.force, false);
        assert.equal(options.body.sha, commit);
        if (fail) throw new Error("provider unavailable");
        observed = commit;
        throw new Error("lost successful response");
      }
      assert.equal(url, "/repos/example/product/git/ref/tags/v1-alpha");
      return { object: { type: "commit", sha: observed } };
    },
  };
  const context = {
    plan: {
      version: "1.0.0-alpha.1",
      channel: "alpha",
      root: recordDigest("plan"),
    },
    materialization: { source: { commit } },
  };
  const retained = {
    qualified: { artifacts: [] },
    documents: {
      transaction: { transactionRoot: recordDigest("transaction") },
    },
  };
  const invoke = () =>
    distributePipelineProducts(context, host, journal, retained, {}, "/unused");
  await assert.rejects(invoke(), /provider unavailable/);
  assert.deepEqual(records[0].value, publication);
  assert.equal(
    records.filter(({ value }) => value.state === "success").length,
    0,
  );
  fail = false;
  const result = await invoke();
  assert.equal(result.receipts[0].state, "success");
  assert.equal(writes, 2);
  await invoke();
  assert.equal(writes, 2);
  observed = "c".repeat(40);
  await assert.rejects(invoke(), /completed publication/);
  assert.equal(writes, 2);
  assert.deepEqual(records[0].value, publication);
});
