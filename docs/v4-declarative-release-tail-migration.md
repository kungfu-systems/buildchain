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
last_reviewed: 2026-09-10
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-10
  visible_context: Buildchain 4.1 source, architecture registries and local validation.
  invisible_context_boundary: No unpublished release or external consumer qualification is claimed.
---

# Adopt the current release promotion API

Call `public-release-promote.yml` with the closed `request-json` contract after
the selected floating channel publishes this API. Keep both channel contract
locks in the consumer repository. See [Promotion request](release-promotion-request.md)
for the complete request and examples.

The declaration-driven provider plane is the sole publisher. There is no mode
switch, command-hook adapter or retained v3 execution path. Candidate identity,
sealed artifact manifests, qualification and provider receipt roots determine
execution and recovery.

On interruption, resume the same candidate and transaction state. The workflow
verifies the source, artifact and policy roots, then continues the incomplete
operations. Completed publication recovery reads the existing evidence and
preserves immutable product bytes.

The 4.1 development merge is not an alpha publication. Consumer adoption waits
for the corresponding published channel contract and refreshed locks.
