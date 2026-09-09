---
status: active
period: ongoing
theme: bootstrap-recovery-distribution
doc_type: manual
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-09
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-09
  visible_context: Recovery workflows, node implementations, dependency closure generator and isolated consumer tests.
  invisible_context_boundary: No production recovery campaign or external consumer deployment was performed.
---

# Consumer-owned bootstrap recovery

The normal entry is `public-ops-bootstrap.yml`. Before depending on it, install
both recovery artifacts from the same reviewed Buildchain package into the
consumer repository:

| Package source | Consumer destination |
| --- | --- |
| `templates/universal-buildchain-bootstrap-recovery.yml` | `.github/workflows/buildchain-bootstrap-recovery.yml` |
| Contents of `templates/bootstrap-recovery/` | `.buildchain/bootstrap-recovery/` |

Commit both artifacts together. The second directory contains three composite
nodes, their complete JavaScript dependency closure, a runtime preparation
action, package identity and a file digest manifest. It must be tracked even
when the consumer otherwise ignores `.buildchain/`. Installing the workflow
alone is incomplete. Do not substitute files from a different package version.

The recovery workflow checks out its own defining consumer commit and invokes
the prepositioned nodes. Request parsing, independent review and terminal
receipt verification start without npm dependencies or a published Buildchain
workflow. Candidate code and its dependencies run only after the consumer-owned
review boundary admits the exact candidate SHA. Provider execution uses the
same candidate engine as the primary route. A failure of GitHub itself remains
an external availability boundary.

The recovery package is generated from the current `actions/workflow/`,
`actions/runtime/` and `packages/core/` implementations. It contains no separate
recovery implementation. `pnpm run generate:workflows` regenerates it and its
admission roots; the normal repository check rejects distribution drift.
Tests copy only these artifacts into a clean temporary consumer and execute
request admission without the Buildchain checkout or `node_modules`.
