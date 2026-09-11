import assert from "node:assert/strict";
import test from "node:test";
import { qualifyPromotion } from "../packages/core/release/promotion/qualification.js";
const sourceSha = "a".repeat(40),
  intent = {
    action: "promote",
    channel: "alpha",
    "target-ref": "alpha/v4/v4.1",
    "requested-sha": sourceSha,
    "source-timestamp": "2026-09-10T00:00:00Z",
  };
const input = {
  request: { "publish-artifact-kind": "custom" },
  workspace: "/tmp/promotion",
  repository: "owner/repo",
  sourceSha,
  sourceRef: "refs/heads/alpha/v4/v4.1",
};
function dependencies(calls) {
  return {
    source: async () => {
      calls.push("source");
      return intent;
    },
    candidate: async () => {
      calls.push("candidate");
      return {
        enabled: true,
        version: "4.1.0-alpha.0",
        artifacts: { sourceSha, passport: "candidate" },
        paths: {
          publishRequiredArtifacts: "required.json",
          passport: "passport.json",
          releaseAssets: ["sealed.tgz"],
        },
      };
    },
    recoverVersion: async () => {
      calls.push("recovery");
      return "4.1.0-alpha.1";
    },
    publication: (value) => {
      calls.push("intent");
      return {
        intent: {
          version: value.recoveredVersion || value.candidateVersion,
          exactTag: "v4.1.0-alpha.1",
          intentRoot: "sha256:" + "a".repeat(64),
        },
        outputPath: value.outputPath,
      };
    },
  };
}
test("qualification combines source, sealed candidate and product intent without effect authority", async () => {
  const calls = [],
    deps = dependencies(calls);
  const result = await qualifyPromotion(input, {}, deps);
  assert.deepEqual(calls, ["source", "candidate", "intent"]);
  assert.equal(result["candidate-source-sha"], sourceSha);
  assert.equal(result["release-artifact-paths"], "sealed.tgz");
  assert.equal(result.version, "4.1.0-alpha.0");
});
test("no-op and rejected declarative input stop before candidate or publication access", async () => {
  const calls = [],
    deps = dependencies(calls);
  assert.equal(
    (
      await qualifyPromotion(
        input,
        {},
        { ...deps, source: async () => ({ action: "noop" }) },
      )
    ).action,
    "noop",
  );
  assert.deepEqual(calls, []);
  await assert.rejects(
    qualifyPromotion(
      { ...input, request: { "publish-command": "arbitrary command" } },
      {},
      deps,
    ),
    /rejects/,
  );
  assert.deepEqual(calls, ["source"]);
});
test("failed candidate qualification cannot create publication intent", async () => {
  const calls = [],
    deps = dependencies(calls);
  await assert.rejects(
    qualifyPromotion(
      input,
      {},
      {
        ...deps,
        candidate: async () => {
          throw Error("candidate bytes differ");
        },
      },
    ),
    /bytes differ/,
  );
  assert.deepEqual(calls, ["source"]);
  await assert.rejects(
    qualifyPromotion(
      input,
      {},
      { ...deps, candidate: async () => ({ enabled: false }) },
    ),
    /not qualified/,
  );
  assert.deepEqual(calls, ["source", "source"]);
});
test("recovery selects the retained publication version before rooting intent", async () => {
  const calls = [],
    deps = dependencies(calls);
  const result = await qualifyPromotion(
    {
      ...input,
      request: { ...input.request, "resume-transaction-id": "transaction" },
    },
    {},
    deps,
  );
  assert.deepEqual(calls, ["source", "candidate", "recovery", "intent"]);
  assert.equal(result.version, "4.1.0-alpha.1");
  assert.equal(result["candidate-version"], "4.1.0-alpha.0");
});
