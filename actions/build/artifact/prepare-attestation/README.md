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

# Prepare a GitHub artifact attestation

Validate the exact subject bytes, platform manifest, release Passport and signer policy before calling the external attestation action. The action runs on Node 24 and verifies the selected Buildchain runtime commit.

Supply `runtime-sha`, `subject-path`, `platform-manifest-path`, `release-passport-path` and `policy-json`. The outputs include the verified subject digest, predicate path and `preparation-json` consumed by the sealing action.

Use the public reusable artifact-attestation workflow for the complete credential and provider boundary. [`action.yml`](action.yml) defines the exact input/output contract; [`seal-attestation`](../seal-attestation/README.md) verifies the provider result.
