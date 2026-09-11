---
status: active
period: ongoing
theme: github-artifact-attestation
doc_type: action-reference
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
  visible_context: Action metadata and attestation transaction source.
  invisible_context_boundary: No hosted publication qualification is claimed.
---

# Seal a GitHub artifact attestation

Verify the external provider result against the preparation record and unchanged subject bytes, then retain the attestation bundle and rooted evidence. The action runs on Node 24 and rechecks the exact selected runtime commit.

Supply `runtime-sha`, `preparation-json`, `bundle-path`, `attestation-id`, `attestation-url` and an explicit read `token`. The outputs identify the retained bundle digest and evidence root. Provider failure or subject drift prevents sealing.

Use the public reusable artifact-attestation workflow for the complete credential and provider boundary. [`action.yml`](action.yml) defines the exact contract; [`prepare-attestation`](../prepare-attestation/README.md) owns pre-provider validation.
