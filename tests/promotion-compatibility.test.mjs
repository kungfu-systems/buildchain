import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORICAL_PROMOTION_ENVELOPE,
  normalizeHistoricalPromotion,
} from "../packages/core/release/promotion/compatibility.js";

const ref =
  "kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v4";
const envelope = (inputs) => ({
  schema: HISTORICAL_PROMOTION_ENVELOPE,
  inputs,
});

test("historical promotion preserves flat candidate and publication arguments", () => {
  const result = normalizeHistoricalPromotion(
    envelope({
      channel: "alpha",
      "target-ref": "alpha/v1/v1.0",
      "buildchain-contract-lock-path": "buildchain.alpha-contract-lock.json",
      "release-candidate-workflow-file": "build.yml",
      "artifact-name": "libnode",
    }),
    ref,
  );
  assert.equal(result.request.channel, "alpha");
  assert.equal(result.request["target-ref"], "alpha/v1/v1.0");
  assert.equal(result.request["release-candidate-workflow-file"], "build.yml");
  assert.equal(result.request["artifact-name"], "libnode");
  assert.equal(
    Object.hasOwn(result.request, "buildchain-contract-lock-path"),
    false,
  );
});

test("historical promotion retains title, commands and exact recovery pins without executing them", () => {
  const legacy = {
    "github-release-title": "Product release",
    "release-passport-kfd-3-artifact-verify-command":
      "node scripts/witness.mjs",
    "resume-expected-candidate-runtime-sha": "a".repeat(40),
    "resume-buildchain-runtime-sha": "b".repeat(40),
  };
  const result = normalizeHistoricalPromotion(envelope(legacy), ref);
  const retained = JSON.parse(result.historical);
  for (const [key, value] of Object.entries(legacy))
    assert.equal(retained.inputs[key], value);
});

test("ordinary typed promotion cannot select a historical envelope or smuggle unknown arguments", () => {
  const modern = {
    schema: "buildchain.promotion-request/v1",
    channel: "release",
  };
  assert.equal(normalizeHistoricalPromotion(modern, "internal").historical, "");
  assert.throws(
    () =>
      normalizeHistoricalPromotion(
        envelope({}),
        "kungfu-systems/buildchain/.github/workflows/.release-candidate-promote.yml@v4",
      ),
    /retained workflow identity/,
  );
  for (const inputs of [
    { unknown: "value" },
    { "dry-run": "false" },
    { "buildchain-ref": 4 },
  ])
    assert.throws(
      () => normalizeHistoricalPromotion(envelope(inputs), ref),
      /historical promotion|Historical promotion/,
    );
  assert.throws(
    () =>
      normalizeHistoricalPromotion(
        envelope({ "branch-protection-bypass-users": "owner" }),
        ref,
      ),
    /rejects/,
  );
  assert.throws(
    () =>
      normalizeHistoricalPromotion(
        { ...modern, "historical-inputs-json": "{}" },
        ref,
      ),
    /Unsupported promotion/,
  );
});

test("the retained entry accepts typed requests but rejects mixed nondefault flat arguments", () => {
  const request = JSON.stringify({
    schema: "buildchain.promotion-request/v1",
    channel: "release",
  });
  const result = normalizeHistoricalPromotion(
    envelope({ "request-json": request }),
    ref,
  );
  assert.equal(result.request.channel, "release");
  assert.deepEqual(JSON.parse(result.historical).inputs, {});
  assert.throws(
    () =>
      normalizeHistoricalPromotion(
        envelope({ "request-json": request, "github-release-title": "mixed" }),
        ref,
      ),
    /Cannot combine/,
  );
});

test("legacy binary publications use the existing custom artifact provider", () => {
  const result = normalizeHistoricalPromotion(
    envelope({ "publish-artifact-kind": "binary" }),
    ref,
  );
  assert.equal(result.request["publish-artifact-kind"], "custom");
  assert.equal(
    JSON.parse(result.historical).inputs["publish-artifact-kind"],
    "binary",
  );
});

test("the historical final-version mode selects the maintained declarative publication provider", () => {
  const result = normalizeHistoricalPromotion(
    envelope({
      "publish-mode": "publish-final-version",
      "publish-package-main": "@kungfu-tech/libnode",
      "publish-package-set-order": "platforms-first-main-last",
    }),
    ref,
  );
  assert.equal(result.request["publish-mode"], "");
  assert.equal(
    JSON.parse(result.historical).inputs["publish-mode"],
    "publish-final-version",
  );
  assert.equal(
    result.request["publish-package-set-order"],
    "platforms-first-main-last",
  );
});
