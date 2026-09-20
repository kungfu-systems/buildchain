---
status: active
period: ongoing
theme: consumer-attempt-recovery
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-20
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-20
  visible_context: Schema-2 consumer contract, pipeline and recovery entries, and internal release implementations.
  invisible_context_boundary: No unobserved hosted publication or external consumer migration is claimed.
---

# Consumer recovery

A current consumer keeps the generated `buildchain.yml` and
`buildchain-recover.yml` beside `.buildchain/buildchain.toml`.
[Initialize the consumer](getting-started.md) to obtain both caller files from
the same Buildchain package. No consumer-owned recovery implementation, copied
JavaScript closure or additional bootstrap workflow is required.

## Normal execution

`buildchain.yml` invokes `public-ops-pipeline.yml` through the published channel.
The runtime owns event routing, source qualification, publication and durable
attempt records. Product install, build and verification commands belong in TOML.

## Recover an interrupted attempt

Open the generated **Buildchain recovery** workflow and provide its exact
`attempt`. If execution requires a repaired runtime, provide the optional
`runtime-ref` for that recovery. The caller invokes `public-ops-recover.yml`.
Keep the durable caller on its published floating channel; the repair selector
is transient and does not replace the attempt's original source or material.

Recovery reads retained records and provider state before issuing remaining
effects. It preserves published bytes and immutable history. A successful build
or a green dispatch alone does not prove publication or terminal settlement.

The recovery form does not accept request JSON, Discussion/run/transaction
selector combinations, replacement artifacts or provider commands. Retained
historical formats are decoded by runtime-owned readers.

## Retired bootstrap distribution

The earlier copied bootstrap recovery workflow and `.buildchain/bootstrap-recovery/`
implementation are historical distribution artifacts. They are not part of the
schema-2 consumer contract and must not be added to new consumers. Internal
bootstrap components and their qualification tests may retain this material for
implementation validation; that does not make it a consumer API.

See [Release discussions](release-discussions.md) for immutable record ownership
and [Release governance](release-governance.md) for the human release flow.
