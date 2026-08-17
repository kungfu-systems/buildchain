---
status: draft
period: 2026-08
theme: adopter-delivery-clean-room
doc_type: analysis
source_level: local-files
confidence: high
sensitivity: internal
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-17
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-17
  invisible_context: unavailable
---

# Ledger specification driver fixture

This synthetic package proves that an adopter can bring its own specification
authority, vectors, verifier, and protocol driver to Buildchain's common
delivery gate. It deliberately contains no KFD schema, claim, package, or
runtime dependency.

The fixture owns ledger semantics: the authority document, admitted claims,
evidence-root algorithm, and fail-closed substitution rules. Buildchain owns
only the protocol-driver interface, immutable package artifact profile,
deterministic gate result, and Passport binding. A passing result remains
non-qualifying and non-self-certifying.

The clean-room test packs both packages, extracts only their published
tarballs into a new temporary module tree, confirms that no KFD package is
installed, and replays the rooted positive and negative vectors offline.
