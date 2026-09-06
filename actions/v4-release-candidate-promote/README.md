---
status: active
period: ongoing
theme: protected-publication-source
doc_type: reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-06
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-06
  visible_context: Publication adapter, regression tests, and public GitHub commit metadata.
  invisible_context_boundary: No credentials or private runtime state inspected.
---

# v4 release-candidate promote action

This internal action validates a sealed v4 publication qualification receipt, aggregates the Buildchain Release Passport, and executes the fixed four-capability Release Tail Provider Plane. It has no command or shell extension input and is invoked by the v4 branch of the reusable `release-candidate-promote` workflow.

The protected publication source must match the qualified candidate's exact
Git tree. An exact commit is accepted directly; a final PR merge may also bind
through identical ordered parents. For repositories requiring linear history,
`squash-equivalent` requires a protected commit with one parent, a qualified
merge candidate with two parents, and the same first parent. GitHub must report
the exact PR as merged into the protected commit, and its head must equal the
candidate's second parent. Candidate qualification, workflow and repository
provenance, and artifact verification remain required before publication.
