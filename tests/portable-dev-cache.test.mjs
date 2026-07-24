import assert from "node:assert/strict";
import test from "node:test";

import {
  createPortableDevCachePlan,
  createPortableDevCacheReceipt,
  verifyPortableDevCachePlan,
} from "../packages/core/portable-dev-cache.js";

const sha = (character) => `sha256:${character.repeat(64)}`;
const manifest = (overrides = {}) => ({
  schema: "buildchain.portable-dev-cache-manifest/v1",
  layer: "dependency",
  roots: [{ id: "conan", path: "~/.conan2/p" }],
  identity: {
    platform: "linux",
    arch: "x64",
    runnerImage: "ubuntu-24.04",
    toolchainDigest: sha("1"),
    dependencyLockDigest: sha("2"),
    profileDigest: sha("3"),
    sourceSha: "4".repeat(40),
    planDigest: sha("5"),
    ...overrides,
  },
});

test("portable plan binds exact source while retaining a compatible restore prefix", () => {
  const first = createPortableDevCachePlan(manifest());
  const next = createPortableDevCachePlan(
    manifest({ sourceSha: "6".repeat(40), planDigest: sha("7") }),
  );
  assert.notEqual(first.key, next.key);
  assert.deepEqual(first.restoreKeys, next.restoreKeys);
  assert.equal(verifyPortableDevCachePlan(first), true);
});

test("toolchain and lock drift cannot reuse a compatibility prefix", () => {
  const first = createPortableDevCachePlan(manifest());
  const toolchain = createPortableDevCachePlan(
    manifest({ toolchainDigest: sha("8") }),
  );
  const lock = createPortableDevCachePlan(
    manifest({ dependencyLockDigest: sha("9") }),
  );
  assert.notDeepEqual(first.restoreKeys, toolchain.restoreKeys);
  assert.notDeepEqual(first.restoreKeys, lock.restoreKeys);
});

test("receipt distinguishes exact, compatible, miss, and corrupt outcomes", () => {
  const plan = createPortableDevCachePlan(manifest());
  assert.equal(
    createPortableDevCacheReceipt({
      plan,
      matchedKey: plan.key,
      cacheHit: "true",
    }).outcome,
    "exact",
  );
  assert.equal(
    createPortableDevCacheReceipt({
      plan,
      matchedKey: `${plan.restoreKeys[0]}older`,
      cacheHit: "false",
    }).outcome,
    "compatible",
  );
  const miss = createPortableDevCacheReceipt({
    plan,
    coldFallbackStatus: "passed",
  });
  assert.equal(miss.outcome, "miss");
  assert.equal(miss.qualified, true);
  const corrupt = createPortableDevCacheReceipt({
    plan,
    matchedKey: plan.key,
    cacheHit: "true",
    validationStatus: "fail",
    validationReason: "fixture corruption",
  });
  assert.equal(corrupt.outcome, "corrupt");
  assert.equal(corrupt.usable, false);
  assert.equal(corrupt.coldFallbackRequired, true);
  assert.equal(corrupt.qualified, false);
});

test("unsafe roots and contradictory provider evidence fail closed", () => {
  assert.throws(
    () =>
      createPortableDevCachePlan({
        ...manifest(),
        roots: [{ id: "escape", path: "../outside" }],
      }),
    /workspace-relative|cannot escape/,
  );
  const plan = createPortableDevCachePlan(manifest());
  assert.throws(
    () =>
      createPortableDevCacheReceipt({
        plan,
        matchedKey: "foreign-key",
        cacheHit: "false",
      }),
    /outside the portable plan authority/,
  );
  assert.throws(
    () =>
      createPortableDevCacheReceipt({ plan, matchedKey: "", cacheHit: "true" }),
    /requires the exact planned key/,
  );
});
