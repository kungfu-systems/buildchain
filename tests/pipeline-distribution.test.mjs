import test from "node:test";
import assert from "node:assert/strict";
import { distributePipelineProducts } from "../packages/core/publication/pipeline/distribution.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

test("distribution only advances Git, preserves npm publication and reconciles a lost response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    assert.fail("normal distribution must not query or mutate npm");
  });
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
    qualified: {
      artifacts: [
        {
          id: "package",
          targets: [{ provider: "npm", access: "public" }],
          package: { name: "example", version: "1.0.0-alpha.1" },
        },
      ],
    },
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

for (const retainedPlan of [true, false])
  test(`historical npm distribution is read-only with retained plan ${retainedPlan}`, async (t) => {
    const effect = {
      id: "npm-channel:package",
      kind: "npm-channel",
      name: "example",
      tag: "alpha",
      version: "1.0.0-alpha.1",
      access: "public",
      expected: { state: "present", version: "1.0.0-alpha.0" },
    };
    const rooted = { ...effect, root: recordDigest(effect) };
    let version = effect.expected.version;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      assert.equal(
        options.method,
        undefined,
        "historical recovery cannot write npm",
      );
      assert.deepEqual(options.headers, {});
      return { ok: true, json: async () => ({ alpha: version }) };
    });
    const original = {
      id: "npm:package",
      kind: "npm-package",
      product: "package",
      name: effect.name,
      version: effect.version,
      integrity: "sealed",
      access: "public",
      tag: `buildchain-${recordDigest("plan").slice(7, 23)}`,
    };
    const records = [];
    const journal = {
      fence: async () => {},
      materials: async (prefix) => {
        if (prefix === "publication/distribution-plan/" && retainedPlan)
          return [{ effects: [rooted] }];
        if (prefix === "publication/effect/")
          return [
            {
              effectId: original.id,
              effectRoot: recordDigest(original),
              state: "success",
            },
          ];
        return [];
      },
      record: async (_id, value) => records.push(value),
    };
    const context = {
      plan: {
        version: effect.version,
        tag: `v${effect.version}`,
        channel: "alpha",
        root: recordDigest("plan"),
      },
      materialization: { source: { commit: "a".repeat(40) } },
    };
    const retained = {
      qualified: {
        source: context.materialization.source,
        artifacts: [
          {
            id: "package",
            targets: [{ provider: "npm", access: "public" }],
            package: {
              name: effect.name,
              version: effect.version,
              integrity: "sealed",
            },
          },
        ],
      },
      documents: {
        passport: { passportRoot: recordDigest("passport") },
        transaction: { transactionRoot: recordDigest("transaction") },
      },
    };
    const invoke = () =>
      distributePipelineProducts(
        context,
        {
          request: async (_url, options = {}) => {
            assert.equal(options.method, undefined);
            return { object: { type: "commit", sha: "a".repeat(40) } };
          },
        },
        journal,
        retained,
        {},
      );
    await assert.rejects(invoke(), /one-time authenticated correction/);
    assert.deepEqual(records, []);
    version = effect.version;
    const result = await invoke();
    const npmEffect = result.effects.find(({ kind }) => kind === "npm-channel");
    if (retainedPlan) assert.deepEqual(npmEffect, rooted);
    const receipt = result.receipts.find(
      ({ effectId }) => effectId === rooted.id,
    );
    assert.equal(receipt.effectRoot, npmEffect.root);
    assert.equal(receipt.state, "success");
    version = "1.0.0-alpha.2";
    await assert.rejects(invoke(), /one-time authenticated correction/);
  });
