---
status: active
period: 2026-08
theme: buildchain-v3-v4-complete-capability-closure
doc_type: capability-inventory
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-27
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-27
  invisible_context: not asserted
---

# Buildchain v3 to v4 live capability inventory

The machine-readable inventory in
[`v3-v4-live-capability-inventory.json`](v3-v4-live-capability-inventory.json)
binds the previous absorption-family v3 cut, the execution-time protected v3
head, and the execution-time protected v4 head. It is an auditable cache of
Git objects and generated registries, not an assertion that branch names remain
unchanged after the recorded cut.

The extractor covers Node subpaths and symbols, CLI commands and flags,
workflow and Action interfaces, schemas and configuration contracts, generated
contracts, release/delivery/recovery mechanisms, observable evidence contracts,
platform branches, documented modules, and every path changed on v3 after the
previous family capture. Each capability has exactly one disposition:
`v4-native`, `compatibility-adapter`, `executable-migration`, or
`owned-missing`.

Run the fail-closed check with:

```sh
node scripts/check-v3-v4-capability-inventory.mjs
```

Refresh the checked-in matrix only after intentionally updating all three exact
cuts and reviewing every newly discovered gap:

```sh
node scripts/check-v3-v4-capability-inventory.mjs --write
```

The extractor rejects a new missing capability unless its exact stable identity
is added to the reviewed residual set with an owner Assignment. It also rejects
unknown dispositions, unowned rows, missing source evidence, missing positive
or negative probes, and non-residual rows without an executable v4 route.

This inventory does not by itself claim stable publication or v3 retirement.
Its public-surface rows bind the exact Child 2 implementation candidate, and
its 13 runtime mechanism families bind the Child 3 semantic closure with
positive, negative, failure, recovery, and idempotence evidence. Cross-platform
adopter qualification, stable-channel closure, and final reconciliation remain
separate ordered Assignments.
