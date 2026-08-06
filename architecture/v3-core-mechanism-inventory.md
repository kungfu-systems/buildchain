---
status: draft
period: 2026-08-05
theme: buildchain-v4-core-mechanism-inventory
doc_type: analysis
source_level: local-files
confidence: high
sensitivity: internal
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-06
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-06
  boundary: Based only on visible repository sources, tests, generated registries, and exact-head Git metadata.
---

# v3 Core Mechanism Inventory

This is the human projection of
[`v3-core-mechanism-inventory.json`](v3-core-mechanism-inventory.json).
The JSON inventory is authoritative and validated by
`scripts/check-core-mechanism-inventory.mjs`.

The exact `dev/v3/v3.0` cut is commit
`9cc135335cd4966b47fb95081dad4e281789bd0d`, tree
`2fbcc21ebf525eb665fcab4f1d839f0cca103f15`. It contains 275
hand-maintained source files, 104,953 source lines, 64 workflows, 225 internal
dependency edges, and zero dependency cycles. These numbers constrain migration
drift; they do not prove semantic correctness.

## Authority map

| Mechanism                   | Current authority and durable state                                        | v4 disposition                                       |
| --------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| Dev Delivery Warrant        | Rooted queue on a selected Git ref; leased candidate admission             | Rust authority with compatibility projection         |
| Release Candidate Passport  | Immutable candidate workflow artifacts and Passport root                   | Preserve schema and byte semantics                   |
| Candidate Recovery          | Original artifacts plus immutable recovery receipt                         | Port verifier first; preserve no-rebuild invariant   |
| Stable Candidate Ledger     | Rooted ledger on `ledger-ref`                                              | Preserve contract; select store authority explicitly |
| Publish Transaction         | Version state Git ref, local state projection, sealed evidence             | Primary Rust transaction authority with v3 reader    |
| Release Activation          | Ordered six-phase transaction and receipt set                              | Port state machine and receipts together             |
| Publication Authority       | Authority registry, admission, gate, provenance and qualification receipts | Rust primary authority; preserve JSON contracts      |
| GitHub Governance           | Provider policy snapshot, CODEOWNERS, rulesets and receipt                 | Separate provider policy adapter                     |
| Passport and Artifact Proof | `buildchain.release.json`, evidence, locators and verification reports     | Preserve public schemas and verifier semantics       |
| Propagation Work Control    | Rooted Work, stage receipts, recovery cursor and family authority          | Reuse as v4 orchestration boundary                   |

## Boundary

This inventory does not choose the v4 store, provider adapter, bridge ABI, or
migration sequence. It records those as unresolved per mechanism. It also does
not change v3 behavior: the only executable addition validates the inventory
against current files and generated/package public-surface registries.

The reverse scan includes workflows, actions, the CLI command registry, package
and Node exports, tests, generated references, and Git-ref-backed stores. A
missing coordinate, absent public surface, empty evidence dimension, or
ambiguous source owner fails the check instead of becoming an implicit v4
assumption.
