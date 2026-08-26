---
status: active
period: ongoing
theme: buildchain-v4-declarative-release-tail
doc_type: migration-guide
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-26
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-26
  invisible_context: unavailable
---

# Migrate a release-candidate promotion to the v4 Provider Plane

Persist the public workflow call at the floating major ref and keep the matching contract lock in the consumer repository:

```yaml
jobs:
  promote:
    uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v4
    with:
      buildchain-contract-lock-path: .buildchain/contract-lock.json
      declarative-release-tail: true
```

The Build/Verify workflow now uploads these candidate-owned inputs together:

- `release-candidate-passport.json`
- `release-candidate-stage-capsules.json`
- `release-candidate-publication-qualification.json`
- the typed payload and manifest artifacts bound by those documents

Remove all v4 values for `publish-command`, `publication-gate-command`, `publication-consumer-qualification-command`, `publication-commit-command`, `release-activation-command`, `release-passport-evidence-command`, KFD/invariant command inputs, and every other `command`, `cmd`, `script`, `shell`, or `run` field. v4 admission rejects them before publication planning. Do not replace them with a wrapper script or a standalone workflow; declare provider evidence and let the reusable workflow execute the fixed Provider Plane.

On interruption, rerun with the same candidate and transaction state. Buildchain verifies the candidate/source/artifact/policy roots and continues from the first missing standardized receipt. Never delete the state file to make a failed capability replay from the beginning.

v3 workflow calls retain their existing command-compatible behavior. Migrating a v3 consumer is an explicit contract change, not an automatic reinterpretation.
