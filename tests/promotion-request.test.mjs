import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { normalizePromotionRequest, bindPromotionInvocation, verifyPromotionInvocation } from "../packages/core/release/promotion-request.js";

const request = { schema: "buildchain.promotion-request/v1" };
const sha = "a".repeat(40);
const root = `sha256:${"b".repeat(64)}`;
const selection = { "runtime-sha": sha, "shell-sha": sha, "router-sha": sha, "shell-call-ref": sha,
  "runtime-ref": sha, "router-ref": "dev/v4/v4.1", "contract-lock-path": ".buildchain/alpha-contract-lock.json",
  "contract-lock-digest": root, channel: "alpha", "publication-channel": "alpha", "target-ref": "alpha/v4/v4.1", "override-used": "false" };
test("promotion request applies every declared default without coercing typed fields", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../contracts/promotion-request-v1.schema.json", import.meta.url)));
  const normalized = normalizePromotionRequest(request);
  for (const [key, property] of Object.entries(schema.properties)) {
    assert.equal(typeof normalized[key], property.type, key);
    if (Object.hasOwn(property, "default")) assert.equal(normalized[key], property.default, key);
  }
  for (const change of [{ schema: "old" }, { "dry-run": "false" }, { "required-artifact-count": "1" }, { "promotion-runtime-sha": sha }, { "branch-protection-bypass-users": "owner" }, { unknown: true }])
    assert.throws(() => normalizePromotionRequest({ ...request, ...change }));
  assert.throws(() => normalizePromotionRequest({}));
});
test("binding produces one current invocation and roots router, publisher, runtime and source lock", () => {
  const invocation = bindPromotionInvocation(request, selection);
  assert.equal(invocation.schema, "buildchain.promotion-invocation/v1");
  assert.equal(invocation["promotion-runtime-sha"], sha);
  assert.equal(invocation["promotion-shell-sha"], sha);
  assert.equal(invocation["promotion-contract-lock-digest"], root);
  assert.equal(invocation["promotion-override-used"], false);
  assert.equal(invocation["target-ref"], selection["target-ref"]);
  assert.equal(Object.hasOwn(invocation, "buildchain-channel"), false);
  for (const change of [{ "contract-lock-digest": "unknown" }, { "override-used": "" }])
    assert.throws(() => bindPromotionInvocation(request, { ...selection, ...change }));
});
test("an entry-selected train runtime needs no second authorization or entry SHA equality", () => {
  const invocation = bindPromotionInvocation(request, { ...selection, "runtime-sha": "c".repeat(40), "runtime-ref": "train/v4/v4.1/repair", "override-used": "true" });
  assert.equal(invocation["promotion-runtime-sha"], "c".repeat(40));
  assert.equal(invocation["promotion-override-used"], true);
  assert.equal(Object.hasOwn(invocation, "promotion-runtime-authorization-root"), false);
  assert.deepEqual(verifyPromotionInvocation(invocation), invocation);
});
test("component invocation retains closed typed normalization and source lock integrity", () => {
  const invocation = bindPromotionInvocation(request, selection);
  assert.deepEqual(verifyPromotionInvocation(invocation), invocation);
  assert.throws(() => verifyPromotionInvocation({ schema: invocation.schema }), /all normalized fields/);
  assert.throws(() => verifyPromotionInvocation({ ...invocation, "promotion-contract-lock-digest": "unrooted" }), /lock root/);
  assert.throws(() => verifyPromotionInvocation({ ...invocation, "dry-run": "false" }), /boolean/);
});
