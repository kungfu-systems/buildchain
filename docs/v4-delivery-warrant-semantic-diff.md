---
status: draft
period: ongoing
theme: buildchain-v4-delivery-warrant
doc_type: contract-guide
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-08
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-08
  invisible_context: not asserted
---

# Delivery Warrant v4 semantic diff gate

The semantic diff gate qualifies paired TypeScript and Rust shadow projections
without moving production authority. TypeScript v3 remains the sole writer,
the Rust host remains effect-disabled, and every report fixes
`v4WriteAuthorized` to `false`.

## Qualification contract

Every case supplies identical public-safe retained bytes to the JavaScript
fixture runner and Rust shadow host. The report binds:

- exact TypeScript and Rust source revisions;
- trace schema, report schema, runner, and validator identities;
- input, JavaScript projection, Rust projection, difference, evidence, and
  retention roots, including a root over each retained full shadow observation;
- golden, bounded property, lease/fence, CAS, duplicate, cancellation,
  response-loss, provider-conflict, and captured-replay coverage;
- bounded fault-probe receipts proving that changes to decisions, successor
  roots, generation, fencing, effects, observations, or receipts are detected.

An unexplained difference, missing observation, incomplete coverage,
undetected fault probe, source-binding mismatch, or retention failure blocks
the gate with a zero retry budget. A compatibility exclusion is accepted only
when its exact difference root, reason code, independent review root, and
disposition root all verify.

The gate requires every full public-safe shadow observation and the final
qualification report to be retained for 90 days. Missing either retention
receipt blocks qualification. It does not accept private payloads, invoke
provider effects, modify v3 authority, or provide a v4 write cutover receipt.

## Run the gate

Call `runV4DeliveryWarrantSemanticDiffGate` with exact source revisions,
explicit observation time, schema and runner roots, public-safe retained cases,
bounded fault probes, an observation retention sink, and a report retention
sink. The returned report is canonical JSON data suitable for a caller-owned
retained evidence file.

The checked-in focused suite exercises that API against the real Rust host:

```sh
node --test tests/v4-delivery-warrant-fixture-runner.test.mjs
```

A qualified report makes only the next
read-candidate stage eligible; it never authorizes v4 writes.

Focused verification:

```sh
pnpm run check:v4-contracts
```
