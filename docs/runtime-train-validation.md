---
status: active
period: ongoing
theme: buildchain-runtime-train-validation
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-08
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-08
  invisible_context: not asserted
---

# Runtime Train Validation

Ordinary builds use the public `build.yml@v4` or `build.yml@v4-alpha`
workflow and select all project settings from `buildchain.toml`. The called
workflow SHA also selects the runtime; there is no second runtime selector.
See [Reusable Build Surface](reusable-build-surface.md) for configuration,
zero-input calls and the optional nested-project locator.

## Alpha qualification

Buildchain changes enter the protected development branch after review and
checks. Publish an alpha through the protected release workflow, then exercise
that public alpha on the exact consumer source. Record the called workflow SHA,
source SHA, channel-matching contract lock, configuration root and artifact
manifests. Promote stable only after the required alpha evidence succeeds.

A train branch is a temporary diagnostic pointer, never a release channel or a
persisted consumer dependency. Ordinary builds do not accept train, SHA or
`buildchain-ref` inputs. Initialization does not create a runtime pass-through.

## Specialized release and recovery

Release and recovery entry points retain their own bounded runtime admission
contracts. Their runtime override capability does not extend to ordinary builds.
Follow [Release Flow](release-flow.md) and the particular entry point's contract;
a diagnostic train does not authorize publication, signing, or floating-ref
movement. Preserve existing source locks, exact candidate lineage and terminal
receipts when recovering a release.

The Buildchain self-build callers exercise the public floating channels using
root or fixture TOML. They do not commit a private runtime selector to qualify
that channel.
