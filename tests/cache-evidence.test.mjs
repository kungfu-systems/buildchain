import assert from "node:assert/strict";
import test from "node:test";

import {
  cacheEvidenceDigest,
  createCacheEvidenceSet,
  createCacheOperationReceipt,
  verifyCacheEvidenceSet,
  verifyCacheOperationReceipt,
} from "../packages/core/cache-evidence.js";

const observed = (unit, value, source = "provider-output") => ({
  status: "observed",
  unit,
  value,
  source,
  evidenceRoot: cacheEvidenceDigest({ unit, value, source }),
});
const unavailable = (unit, reason) => ({
  status: "unavailable",
  unit,
  value: null,
  reason,
});
const notApplicable = (unit, reason) => ({
  status: "not-applicable",
  unit,
  value: null,
  reason,
});

function input(overrides = {}) {
  return {
    operationId: "source-checkout:linux-x64",
    operation: "restore",
    provider: "git-reference-repository",
    producer: "kungfu-systems/buildchain",
    platform: "linux-x64",
    cacheKey: "sha256:source-cache-key",
    cacheRoot: "sha256:source-cache-root",
    outcome: "hit",
    bindings: {
      sourceCommit: "a".repeat(40),
      sourceTree: "b".repeat(40),
      runtimeCommit: "c".repeat(40),
      toolchainRoot: `sha256:${"d".repeat(64)}`,
    },
    metrics: {
      lookupDuration: observed("ms", 12),
      restoreDuration: observed("ms", 34),
      saveDuration: notApplicable("ms", "restore operation does not save"),
      restoredBytes: observed("bytes", 4096),
      writtenBytes: notApplicable("bytes", "restore operation does not save"),
      savedTime: unavailable(
        "ms",
        "provider did not report a measured cold-path comparison",
      ),
    },
    evidence: {
      kind: "locked-source-checkout",
      root: cacheEvidenceDigest({ source: "checkout" }),
      locator: ".buildchain/diagnostics/source-checkout.json",
    },
    ...overrides,
  };
}

test("cache operation receipts retain exact identities and observed metrics", () => {
  const receipt = createCacheOperationReceipt(input());
  assert.equal(receipt.outcome, "hit");
  assert.equal(receipt.metrics.restoredBytes.value, 4096);
  assert.equal(receipt.metrics.savedTime.status, "unavailable");
  assert.match(receipt.receiptRoot, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verifyCacheOperationReceipt(receipt), true);
});

test("cache evidence sets bind unique operations to one source and platform", () => {
  const operation = createCacheOperationReceipt(input());
  const receipt = createCacheEvidenceSet({
    repository: "kungfu-systems/kungfu",
    sourceCommit: "a".repeat(40),
    sourceTree: "b".repeat(40),
    runtimeCommit: "c".repeat(40),
    platform: "linux-x64",
    operations: [operation],
  });
  assert.equal(receipt.operations[0].receiptRoot, operation.receiptRoot);
  assert.equal(verifyCacheEvidenceSet(receipt), true);
  assert.throws(
    () =>
      createCacheEvidenceSet({
        ...receipt,
        operations: [operation, operation],
      }),
    /operation ids must be unique/,
  );
});

test("forged time savings without producer evidence fail closed", () => {
  const forged = input();
  forged.metrics.savedTime = observed("ms", 9000, "step-name-inference");
  assert.throws(
    () => createCacheOperationReceipt(forged),
    /observed saved time requires producer-measured or provider-reported/,
  );
});

test("cross-toolchain and unknown binding names fail closed", () => {
  const invalid = input();
  invalid.bindings.undeclaredToolchain = `sha256:${"e".repeat(64)}`;
  assert.throws(
    () => createCacheOperationReceipt(invalid),
    /bindings\.undeclaredToolchain is not allowed/,
  );
});

test("tampered outcomes or byte claims invalidate the receipt root", () => {
  const receipt = createCacheOperationReceipt(input());
  receipt.outcome = "poisoned";
  receipt.metrics.restoredBytes.value = 1;
  assert.throws(
    () => verifyCacheOperationReceipt(receipt),
    /cache operation receipt root mismatch/,
  );
});
