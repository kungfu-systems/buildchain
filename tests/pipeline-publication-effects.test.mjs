import test from "node:test";
import assert from "node:assert/strict";
import { applyPipelineEffects } from "../packages/core/publication/pipeline/effects.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

function setup() {
  const effects = ["first", "second"].map((id) => {
    const body = { id, kind: "npm-package", integrity: `digest-${id}` };
    return { ...body, root: recordDigest(body) };
  });
  const receipts = [],
    remote = new Map(),
    writes = [];
  let failSecond = true,
    active = true,
    loseReceipt = false;
  const input = {
    effects,
    transactionRoot: recordDigest("transaction"),
    receipts,
    fence: async () => {
      if (!active) throw new Error("superseded attempt");
    },
    retain: async (receipt) => {
      if (loseReceipt && receipt.state === "success") {
        loseReceipt = false;
        throw new Error("journal response lost");
      }
      receipts.push(receipt);
    },
    provider: {
      observe: async (effect) =>
        remote.has(effect.id)
          ? { state: "present", integrity: remote.get(effect.id) }
          : { state: "absent" },
      matches: (effect, observed) =>
        observed.state === "present" && observed.integrity === effect.integrity,
      apply: async (effect) => {
        writes.push(effect.id);
        if (effect.id === "second" && failSecond)
          throw new Error("registry unavailable");
        remote.set(effect.id, effect.integrity);
        throw new Error("successful write response lost");
      },
    },
  };
  return {
    input,
    receipts,
    remote,
    writes,
    repair: () => {
      failSecond = false;
    },
    supersede: () => {
      active = false;
    },
    loseReceipt: () => {
      loseReceipt = true;
    },
  };
}

test("partial package publication preserves first success and resumes only missing bytes", async () => {
  const f = setup();
  await assert.rejects(applyPipelineEffects(f.input), /registry unavailable/);
  const first = structuredClone(
    f.receipts.find((receipt) => receipt.state === "success"),
  );
  assert.equal(first.effectId, "first");
  f.repair();
  await applyPipelineEffects(f.input);
  assert.deepEqual(f.writes, ["first", "second", "second"]);
  assert.deepEqual(
    f.receipts.find((receipt) => receipt.state === "success"),
    first,
  );
  await applyPipelineEffects(f.input);
  assert.deepEqual(f.writes, ["first", "second", "second"]);
});

test("lost journal receipt reconciles provider bytes while conflicting or superseded attempts cannot write", async () => {
  const f = setup();
  f.loseReceipt();
  await assert.rejects(applyPipelineEffects(f.input), /journal response lost/);
  f.repair();
  await applyPipelineEffects(f.input);
  assert.deepEqual(f.writes, ["first", "second"]);
  f.remote.set("first", "different historical bytes");
  await assert.rejects(applyPipelineEffects(f.input), /completed publication/);
  assert.deepEqual(f.writes, ["first", "second"]);
  f.supersede();
  await assert.rejects(applyPipelineEffects(f.input), /superseded/);
});
