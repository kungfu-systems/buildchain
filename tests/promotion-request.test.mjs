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
  assert.equal(invocation["buildchain-ref"], sha);
  assert.equal(invocation["promotion-shell-sha"], sha);
  assert.equal(invocation["promotion-contract-lock-digest"], root);
  assert.equal(invocation["promotion-override-used"], false);
  assert.equal(invocation["target-ref"], selection["target-ref"]);
  assert.equal(Object.hasOwn(invocation, "buildchain-channel"), false);
  for (const change of [{ "shell-sha": "c".repeat(40) }, { "runtime-sha": "v4-alpha" }, { "contract-lock-digest": "unknown" }, { "override-used": "true" }, { "override-used": "" }])
    assert.throws(() => bindPromotionInvocation(request, { ...selection, ...change }));
});
test("transient runtime selection requires its independently rooted authorization", () => {
  const invocation = bindPromotionInvocation(request, { ...selection, "override-used": "true" }, { "runtime-authorization-json": '{"receipt":{}}', "runtime-authorization-root": root });
  assert.equal(invocation["promotion-override-used"], true);
  assert.equal(invocation["promotion-runtime-authorization-root"], root);
});

test("component invocation rejects missing normalization and another publisher SHA", () => {
  const invocation = bindPromotionInvocation(request, selection);
  assert.deepEqual(verifyPromotionInvocation(invocation, sha), invocation);
  assert.throws(() => verifyPromotionInvocation({ schema: invocation.schema }, sha), /all normalized fields/);
  assert.throws(() => verifyPromotionInvocation(invocation, "c".repeat(40)), /defining workflow/);
});
