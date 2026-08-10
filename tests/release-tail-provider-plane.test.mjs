import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  RELEASE_TAIL_OBSERVATION_SCHEMA,
  RELEASE_TAIL_RECEIPT_SCHEMA,
  compileReleaseTailDeclaration,
  createReleaseTailAdapterSet,
  createReleaseTailTransaction,
  executeReleaseTailTransaction,
  parseReleaseTailDeclaration,
  validateReleaseTailEffectPlan,
  validateReleaseTailTransaction,
} from "../packages/core/release-tail-provider-plane.js";
import { ReleaseTailProviderError } from "../packages/core/release-tail-provider-adapters.js";
import { diagnoseLegacyReleaseTailHooks } from "../packages/core/release-tail-compatibility.js";

function declaration() {
  return JSON.parse(
    fs.readFileSync(
      "contracts/fixtures/release-tail-capabilities-v1/kungfu-alpha.json",
      "utf8",
    ),
  );
}

function memoryAdapters(input, overrides = {}) {
  const state = new Map();
  const calls = new Map();
  const adapters = {};
  for (const capability of input.capabilities) {
    const implementation = overrides[capability.id] || {};
    adapters[capability.adapter] = {
      async readback(effect) {
        calls.set(
          `${effect.capabilityId}:readback`,
          (calls.get(`${effect.capabilityId}:readback`) || 0) + 1,
        );
        if (implementation.readback) {
          return implementation.readback(effect, state, calls);
        }
        return state.has(effect.operationId)
          ? {
              outcome: "observed",
              subjectRoot: effect.subjectRoot,
              targetRoot: state.get(effect.operationId),
              evidenceRoots: [effect.targetRoot],
              providerCode: "memory-observed",
            }
          : { outcome: "absent", providerCode: "memory-absent" };
      },
      async apply(effect) {
        calls.set(
          `${effect.capabilityId}:apply`,
          (calls.get(`${effect.capabilityId}:apply`) || 0) + 1,
        );
        if (implementation.apply) {
          return implementation.apply(effect, state, calls);
        }
        state.set(effect.operationId, effect.targetRoot);
      },
    };
  }
  return {
    adapters: createReleaseTailAdapterSet(input, adapters),
    state,
    calls,
  };
}

test("frozen declarations compile to one deterministic ordered effect plan", () => {
  const input = declaration();
  const first = compileReleaseTailDeclaration(input);
  input.capabilities.reverse();
  const second = compileReleaseTailDeclaration(input);
  assert.deepEqual(second, first);
  assert.deepEqual(
    first.effects.map((effect) => effect.capabilityId),
    [
      "artifact.publish",
      "signed-channel.commit",
      "release.activate",
      "released-evidence.synthesize",
    ],
  );
  assert.equal(
    new Set(first.effects.map((effect) => effect.transactionRoot)).size,
    1,
  );
  assert.equal(
    new Set(first.effects.map((effect) => effect.operationId)).size,
    4,
  );
});

test("declaration parser rejects executable data and identity drift", () => {
  const executable = declaration();
  executable.capabilities[0].destination.shell = "npm publish";
  assert.throws(
    () => parseReleaseTailDeclaration(executable),
    /executable key 'shell' is forbidden/u,
  );

  const drifted = declaration();
  drifted.capabilities[1].operationIdentity.capabilityId = "artifact.publish";
  assert.throws(
    () => parseReleaseTailDeclaration(drifted),
    /capabilityId must match/u,
  );
});

test("effect plans are rooted and reject post-compilation tampering", () => {
  const plan = compileReleaseTailDeclaration(declaration());
  assert.equal(validateReleaseTailEffectPlan(plan).valid, true);
  const tampered = structuredClone(plan);
  tampered.effects[0].targetRoot = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => createReleaseTailTransaction(tampered),
    /operationId mismatch|effectRoot mismatch|planRoot mismatch/u,
  );
});

test("all capabilities settle through one transaction and standardized envelopes", async () => {
  const input = declaration();
  const memory = memoryAdapters(input);
  const checkpoints = [];
  const result = await executeReleaseTailTransaction(
    createReleaseTailTransaction(input),
    {
      adapters: memory.adapters,
      checkpoint: (transaction) => checkpoints.push(transaction.stateRoot),
    },
  );
  assert.equal(result.state, "complete");
  assert.equal(result.receipts.length, 4);
  assert.equal(result.observations.length, 8);
  assert.equal(validateReleaseTailTransaction(result).valid, true);
  assert.ok(checkpoints.length >= 12);
  for (const operation of result.operations) {
    assert.equal(operation.status, "complete");
    assert.equal(operation.effectAttempts, 1);
    assert.equal(operation.readbackAttempts, 2);
    assert.equal(operation.receipt.schema, RELEASE_TAIL_RECEIPT_SCHEMA);
    assert.ok(operation.observationRoots.length >= 2);
  }
});

test("effect success with a lost response completes from post-effect readback", async () => {
  const input = declaration();
  const memory = memoryAdapters(input, {
    "artifact.publish": {
      apply(effect, state) {
        state.set(effect.operationId, effect.targetRoot);
        throw new ReleaseTailProviderError("response lost", {
          code: "network-response-lost",
          classification: "transient",
        });
      },
    },
  });
  const result = await executeReleaseTailTransaction(
    createReleaseTailTransaction(input),
    { adapters: memory.adapters },
  );
  assert.equal(result.state, "complete");
  assert.equal(memory.calls.get("artifact.publish:apply"), 1);
  assert.equal(result.operations[0].receipt.action, "applied-and-observed");
});

test("duplicate invocation returns the settled transaction without provider effects", async () => {
  const input = declaration();
  const firstMemory = memoryAdapters(input);
  const complete = await executeReleaseTailTransaction(
    createReleaseTailTransaction(input),
    { adapters: firstMemory.adapters },
  );
  const replayMemory = memoryAdapters(input);
  const replayed = await executeReleaseTailTransaction(complete, {
    adapters: replayMemory.adapters,
  });
  assert.deepEqual(replayed, complete);
  assert.equal(replayMemory.calls.size, 0);
});

test("stale or partial public state enters repair-required without mutation", async () => {
  const input = declaration();
  const memory = memoryAdapters(input, {
    "artifact.publish": {
      readback(effect) {
        return {
          outcome: "observed",
          subjectRoot: effect.subjectRoot,
          targetRoot: `sha256:${"f".repeat(64)}`,
          providerCode: "partial-provider-state",
        };
      },
    },
  });
  const result = await executeReleaseTailTransaction(
    createReleaseTailTransaction(input),
    { adapters: memory.adapters },
  );
  assert.equal(result.state, "repair-required");
  assert.equal(result.failure.code, "stale-readback");
  assert.equal(memory.calls.get("artifact.publish:apply"), undefined);
});

test("credential and network transients are bounded and never mutate without readback", async () => {
  const input = declaration();
  const memory = memoryAdapters(input, {
    "artifact.publish": {
      readback() {
        return {
          outcome: "transient",
          providerCode: "credential-transient",
        };
      },
    },
  });
  const result = await executeReleaseTailTransaction(
    createReleaseTailTransaction(input),
    { adapters: memory.adapters },
  );
  assert.equal(result.state, "repair-required");
  assert.equal(result.failure.code, "local-retry-exhausted");
  assert.equal(memory.calls.get("artifact.publish:readback"), 3);
  assert.equal(memory.calls.get("artifact.publish:apply"), undefined);
});

test("terminal provider conflicts fail closed", async () => {
  const input = declaration();
  const memory = memoryAdapters(input, {
    "artifact.publish": {
      readback() {
        return { outcome: "conflict", providerCode: "immutable-collision" };
      },
    },
  });
  const result = await executeReleaseTailTransaction(
    createReleaseTailTransaction(input),
    { adapters: memory.adapters },
  );
  assert.equal(result.state, "terminal-failure");
  assert.equal(result.failure.code, "provider-conflict");
});

test("observations are rooted standardized records rather than adapter decisions", async () => {
  const input = declaration();
  const memory = memoryAdapters(input);
  const result = await executeReleaseTailTransaction(
    createReleaseTailTransaction(input),
    { adapters: memory.adapters },
  );
  const observationRoots = result.operations.flatMap(
    (entry) => entry.observationRoots,
  );
  assert.equal(
    observationRoots.every((root) => /^sha256:[0-9a-f]{64}$/u.test(root)),
    true,
  );
  assert.deepEqual(
    result.observations.map((entry) => entry.observationRoot),
    observationRoots,
  );
  assert.equal(
    RELEASE_TAIL_OBSERVATION_SCHEMA,
    "kungfu.buildchain.release-tail.observation/v1",
  );
});

test("v3 compatibility emits bounded deprecation diagnostics and rejects new hooks", () => {
  const compatible = diagnoseLegacyReleaseTailHooks({
    "publish-command": "npm publish",
    "release-activation-command": "node activate.mjs",
  });
  assert.equal(compatible.compatible, true);
  assert.equal(compatible.diagnostics.length, 2);
  assert.equal(
    compatible.diagnostics.every(
      (entry) => entry.code === "release-tail-hook-deprecated",
    ),
    true,
  );
  assert.equal(compatible.migrationWindow.permanentEscapeHatch, false);

  const forbidden = diagnoseLegacyReleaseTailHooks({
    "new-provider-command": "curl https://provider.invalid",
  });
  assert.equal(forbidden.compatible, false);
  assert.equal(forbidden.diagnostics[0].code, "release-tail-command-forbidden");
});
