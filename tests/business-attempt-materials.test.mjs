import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { identities } from "./helpers/business-attempt.mjs";
import {
  materialReference,
  verifyMaterialBytes,
} from "../packages/core/workflow/attempt/materials.js";
import { readBusinessAttempt } from "../packages/core/workflow/attempt/reader.js";

function material(f, bytes = Buffer.from("immutable receipt")) {
  return {
    id: "candidate/receipt",
    kind: "receipt",
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.length,
    url: "https://github.com/example/consumer/releases/download/retained-evidence/receipt.json",
    generation: f.attempt.generation,
    producerAttempt: f.attempt.id,
  };
}

test("retained checkpoint/receipt/Passport bytes have exact attempt identity and integrity", () => {
  const f = identities(),
    bytes = Buffer.from("immutable receipt"),
    ref = material(f, bytes);
  assert.equal(verifyMaterialBytes(ref, bytes).digest, ref.digest);
  assert.throws(
    () => verifyMaterialBytes(ref, Buffer.from("immutable receipT")),
    /integrity mismatch/,
  );
  assert.throws(
    () => verifyMaterialBytes(ref, bytes.subarray(1)),
    /integrity mismatch/,
  );
  for (const extra of [
    { generation: `sha256:${"f".repeat(64)}` },
    { producerAttempt: `attempt-${"f".repeat(64)}` },
    { url: ref.url + "?token=PRIVATE" },
    { url: "https://evil.example/material" },
    { bytes: 0 },
  ])
    assert.throws(() => materialReference({ ...ref, ...extra }, f.attempt));
  assert.throws(
    () =>
      f.event(null, {
        materials: [
          {
            ...ref,
            url: "https://github.com/other/repository/releases/download/tag/receipt.json",
          },
        ],
      }),
    /another consumer repository/,
  );
  const root = f.event(),
    admitted = f.event(root, { state: "success", materials: [ref] });
  const observed = readBusinessAttempt({
    intent: f.intent,
    records: [root, admitted],
  });
  assert.deepEqual(observed.materials[ref.id], ref);
  const conflicting = f.event(admitted, {
    phase: "build",
    materials: [{ ...ref, digest: `sha256:${"f".repeat(64)}` }],
  });
  assert.throws(
    () =>
      readBusinessAttempt({
        intent: f.intent,
        records: [root, admitted, conflicting],
      }),
    /Immutable material identity/,
  );
  assert.throws(() => f.event(null, { materials: [ref, ref] }), /duplicate/);
  assert.throws(
    () => f.event(null, { materials: Array(101).fill(ref) }),
    /bound/,
  );
});
