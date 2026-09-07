import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ContractFault,
  domainCanonicalBytes,
} from "../packages/core/canonical-contracts.js";
import { StageCapsuleLocalStore } from "../packages/core/stage-capsule-local-store.js";
import {
  createStageCapsuleProviderAdapter,
  createStageCapsuleRetentionState,
  createStageCapsuleStoreReceipt,
  createStageCapsuleTransport,
  stageCapsuleBlobRoot,
  stageCapsuleOutputManifestRoot,
  validateStageCapsuleOutputManifest,
  validateStageCapsuleRetentionState,
  validateStageCapsuleStoreReceipt,
  validateStageCapsuleTransport,
} from "../packages/core/stage-capsule-store.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = new URL(
  "../contracts/fixtures/v4-stage-capsule-store-v1/shared.json",
  import.meta.url,
);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const entry = fixtures.validCases[0];
const recordedAt = entry.evaluatedAt;
const locatorRoot = entry.transport.locatorRoot;

function blobs() {
  return entry.blobs.map(({ name, bytesBase64 }) => ({
    name,
    bytes: Buffer.from(bytesBase64, "base64"),
  }));
}

function temporaryStore() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-stage-capsule-store-"),
  );
  return {
    directory,
    store: new StageCapsuleLocalStore(directory, { locatorRoot }),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function put(store) {
  return store.put({
    capsule: structuredClone(entry.capsule),
    manifest: structuredClone(entry.manifest),
    blobs: blobs(),
    recordedAt,
  });
}

function blobPath(directory, rootValue) {
  return path.join(
    directory,
    "blobs",
    "sha256",
    rootValue.slice("sha256:".length),
  );
}

test("store contracts freeze byte-identical JavaScript and Rust roots", () => {
  assert.equal(
    stageCapsuleOutputManifestRoot(entry.manifest),
    entry.manifest.manifestRoot,
  );
  assert.equal(
    validateStageCapsuleOutputManifest(entry.manifest),
    entry.manifest,
  );
  assert.deepEqual(
    createStageCapsuleRetentionState({
      capsule: entry.capsule,
      evaluatedAt: entry.evaluatedAt,
    }),
    entry.retentionState,
  );
  assert.equal(
    validateStageCapsuleRetentionState(entry.retentionState),
    entry.retentionState,
  );
  assert.deepEqual(
    createStageCapsuleTransport(entry.transport),
    entry.transport,
  );
  assert.equal(validateStageCapsuleTransport(entry.transport), entry.transport);
  assert.deepEqual(
    createStageCapsuleStoreReceipt(entry.receipt),
    entry.receipt,
  );
  assert.equal(validateStageCapsuleStoreReceipt(entry.receipt), entry.receipt);
  for (const blob of entry.blobs)
    assert.equal(
      stageCapsuleBlobRoot(Buffer.from(blob.bytesBase64, "base64")),
      blob.root,
    );

  const result = spawnSync(
    process.platform === "win32" ? "cargo.exe" : "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-domain-contracts/Cargo.toml",
      "--",
      "stage-capsule-store",
      "contracts/fixtures/v4-stage-capsule-store-v1/shared.json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    result.error?.stack || result.stderr || result.stdout,
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    validCases: [
      {
        id: entry.id,
        manifestRoot: entry.manifest.manifestRoot,
        retentionStateRoot: entry.retentionState.stateRoot,
        transportRoot: entry.transport.transportRoot,
        availabilityRoot: entry.receipt.availabilityRoot,
        receiptRoot: entry.receipt.receiptRoot,
        blobRoots: entry.blobs.map(({ root: blobRoot }) => blobRoot),
      },
    ],
  });
});

test("a clean process restores exact capsule, manifest, and blob bytes by root", () => {
  const fixture = temporaryStore();
  try {
    const stored = put(fixture.store);
    assert.equal(stored.outcome, "stored");
    const cleanProcessStore = new StageCapsuleLocalStore(fixture.directory, {
      locatorRoot,
    });
    const restored = cleanProcessStore.restore({
      capsuleRoot: entry.capsule.capsuleRoot,
      recordedAt,
    });
    assert.deepEqual(restored.capsule, entry.capsule);
    assert.deepEqual(restored.manifest, entry.manifest);
    assert.deepEqual(
      restored.blobs.map(({ name, root: blobRoot, bytes }) => ({
        name,
        root: blobRoot,
        bytesBase64: bytes.toString("base64"),
      })),
      entry.blobs,
    );
    assert.equal(restored.receipt.outcome, "restored");
    assert.equal(restored.availability.status, "available");
  } finally {
    fixture.cleanup();
  }
});

test("repeated put and restore are idempotent and physical paths do not affect identity", () => {
  const first = temporaryStore();
  const second = temporaryStore();
  try {
    assert.equal(put(first.store).outcome, "stored");
    assert.equal(put(first.store).outcome, "already-stored");
    assert.equal(put(second.store).capsuleRoot, entry.capsule.capsuleRoot);
    const restoredFirst = first.store.restore({
      capsuleRoot: entry.capsule.capsuleRoot,
      recordedAt,
    });
    const restoredSecond = second.store.restore({
      capsuleRoot: entry.capsule.capsuleRoot,
      recordedAt,
    });
    assert.equal(
      restoredFirst.capsule.capsuleRoot,
      restoredSecond.capsule.capsuleRoot,
    );
    assert.equal(
      restoredFirst.manifest.manifestRoot,
      restoredSecond.manifest.manifestRoot,
    );
    assert.deepEqual(
      restoredFirst.blobs.map(({ bytes }) => bytes),
      restoredSecond.blobs.map(({ bytes }) => bytes),
    );
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("missing, expired, partial, corrupt, quarantined, and root mismatch fail closed", () => {
  const missing = temporaryStore();
  try {
    assert.equal(
      missing.store.observe({
        capsuleRoot: entry.capsule.capsuleRoot,
        observedAt: recordedAt,
      }).availability.status,
      "missing",
    );
  } finally {
    missing.cleanup();
  }

  const expired = temporaryStore();
  try {
    put(expired.store);
    assert.throws(
      () =>
        expired.store.restore({
          capsuleRoot: entry.capsule.capsuleRoot,
          recordedAt: "2026-11-08T00:00:00.000Z",
        }),
      (error) =>
        error instanceof ContractFault &&
        error.code === "stage-capsule-expired",
    );
  } finally {
    expired.cleanup();
  }

  const partial = temporaryStore();
  try {
    put(partial.store);
    fs.rmSync(blobPath(partial.directory, entry.manifest.entries[0].root));
    assert.equal(
      partial.store.observe({
        capsuleRoot: entry.capsule.capsuleRoot,
        observedAt: recordedAt,
      }).availability.status,
      "partial",
    );
  } finally {
    partial.cleanup();
  }

  const corrupt = temporaryStore();
  try {
    put(corrupt.store);
    const target = blobPath(corrupt.directory, entry.manifest.entries[0].root);
    fs.chmodSync(target, 0o644);
    fs.writeFileSync(target, "changed");
    assert.equal(
      corrupt.store.observe({
        capsuleRoot: entry.capsule.capsuleRoot,
        observedAt: recordedAt,
      }).availability.status,
      "corrupt",
    );
  } finally {
    corrupt.cleanup();
  }

  const quarantined = temporaryStore();
  try {
    put(quarantined.store);
    quarantined.store.quarantine({
      capsuleRoot: entry.capsule.capsuleRoot,
      recordedAt,
      reason: "operator-review",
    });
    assert.equal(
      quarantined.store.observe({
        capsuleRoot: entry.capsule.capsuleRoot,
        observedAt: recordedAt,
      }).availability.status,
      "quarantined",
    );
  } finally {
    quarantined.cleanup();
  }

  const mismatched = temporaryStore();
  try {
    put(mismatched.store);
    const capsulePath = mismatched.store.paths(
      entry.capsule.capsuleRoot,
    ).capsule;
    const changed = structuredClone(entry.capsule);
    changed.capsuleRoot = `sha256:${"e".repeat(64)}`;
    fs.chmodSync(capsulePath, 0o644);
    fs.writeFileSync(capsulePath, domainCanonicalBytes(changed));
    assert.equal(
      mismatched.store.observe({
        capsuleRoot: entry.capsule.capsuleRoot,
        observedAt: recordedAt,
      }).availability.status,
      "root-mismatch",
    );
  } finally {
    mismatched.cleanup();
  }
});

test("retention, availability, transport, qualification, and receipt remain distinct rooted facts", () => {
  const fixture = temporaryStore();
  try {
    const receipt = put(fixture.store);
    const located = fixture.store.locate({
      capsuleRoot: entry.capsule.capsuleRoot,
      recordedAt,
    });
    const roots = new Set([
      receipt.retentionStateRoot,
      receipt.availabilityRoot,
      receipt.transportRoot,
      receipt.qualificationRoot,
      receipt.receiptRoot,
    ]);
    assert.equal(roots.size, 5);
    const later = fixture.store.observe({
      capsuleRoot: entry.capsule.capsuleRoot,
      observedAt: "2026-08-11T00:00:00.000Z",
    });
    assert.notEqual(
      located.transport.transportRoot,
      later.transport.transportRoot,
    );
    assert.equal(later.stored.capsule.capsuleRoot, entry.capsule.capsuleRoot);
  } finally {
    fixture.cleanup();
  }
});

test("provider adapters are effect-disabled or explicitly fixture-backed", () => {
  const github = createStageCapsuleProviderAdapter({
    provider: "github-artifacts",
  });
  assert.throws(
    () => github.put({}),
    (error) =>
      error instanceof ContractFault &&
      error.code === "stage-capsule-transport-disabled",
  );
  const s3 = createStageCapsuleProviderAdapter({
    provider: "s3-compatible",
    mode: "fixture-backed",
    fixture: { restore: ({ capsuleRoot }) => ({ capsuleRoot }) },
  });
  const restoreRequest = {
    capsuleRoot: entry.capsule.capsuleRoot,
    locatorRoot,
    recordedAt,
  };
  assert.deepEqual(s3.restore(restoreRequest), {
    authority: "fixture-only",
    provider: "s3-compatible",
    result: { capsuleRoot: entry.capsule.capsuleRoot },
  });
  assert.throws(
    () => s3.restore({ ...restoreRequest, credential: "not-admitted" }),
    (error) =>
      error instanceof ContractFault &&
      error.code === "invalid-stage-capsule-store-shape",
  );
});

test("store architecture budgets three bounded sources and zero authority drift", () => {
  const contract = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/stage-capsule-store-contract.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    contract.identityAuthority,
    "architecture/stage-capsule-contract.json",
  );
  assert.deepEqual(contract.authority, {
    writer: "typescript-v3",
    rust: "validation-only",
    localStore: "reference-effect-only",
    providerAdapters: "effect-disabled-or-fixture-backed",
    productionWriteChange: false,
  });
  assert.deepEqual(contract.budgets, {
    newHandMaintainedSourceFiles: 3,
    providerSdkImports: 0,
    networkEffects: 0,
    productionProviderMutations: 0,
    cacheFallbacks: 0,
    credentialFields: 0,
    ambientClocks: 0,
    productionWriteAuthorityChanges: 0,
    v3ConsumerBehaviorChanges: 0,
  });
});

test("store implementation has no provider SDK, credential, cache fallback, network, or ambient clock", () => {
  const files = [
    "packages/core/stage-capsule-store.js",
    "packages/core/stage-capsule-local-store.js",
    "crates/buildchain-domain-contracts/src/stage_capsule_store.rs",
  ].map((file) =>
    fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
  );
  for (const forbidden of [
    "Octokit",
    "@aws-sdk",
    "process.env",
    "Date.now(",
    "new Date(",
    "node:https",
    "cacheHit",
    "fallback",
    "reqwest",
    "std::net",
    "std::env",
    "SystemTime",
  ])
    assert.equal(
      files.some((contents) => contents.includes(forbidden)),
      false,
      forbidden,
    );
});
