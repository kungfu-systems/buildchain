---
status: active
period: ongoing
theme: buildchain-layered-architecture
doc_type: implementation-guide
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
  visible_context: Buildchain 4.1 source, architecture registries and local validation.
  invisible_context_boundary: No unpublished release or external consumer qualification is claimed.
---

# Adopt the minimal consumer pipeline

Use the generated `buildchain.yml` and `buildchain-recover.yml` with the schema-2
`.buildchain/buildchain.toml`. The shared public workflows are
`public-ops-pipeline.yml` and `public-ops-recover.yml`. See
[Getting started](getting-started.md) for initialization.

The normal pipeline owns the declaration-driven provider plane. Products declare
build/verify commands, artifacts and publication targets in TOML. Consumers do not
call a separate promotion workflow, supply request JSON, or implement release-tail
command hooks. Candidate identity, sealed materials, qualification and provider
receipts remain internal runtime authority.

On interruption, select the exact attempt in the generated recovery workflow.
An optional repaired runtime can continue remaining work while preserving the
original source, published bytes and historical evidence. Do not combine
candidate/run/Discussion/transaction selectors in consumer wiring.

A development merge is not a published entry. Adopt the changed contract only
after its selected channel publishes and qualifies it, then refresh the
corresponding tool-maintained locks through the supported acceptance path.
