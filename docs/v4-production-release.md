---
status: active
period: ongoing
theme: buildchain-v4-production-release
doc_type: runbook
source_level: repository-contracts + protected-provider-readback
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-13
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-13
  invisible_context: Provider credentials and private provider state were not read.
---

# Buildchain v4 production release

Buildchain v4 is the production release authority for the `v4.0` line. The
protected source path is:

```text
dev/v4/v4.0 -> alpha/v4/v4.0 -> release/v4/v4.0
```

Public consumers use `v4-alpha` for the current prerelease channel and `v4`
for stable. Reproducible consumers may pin an exact 40-character commit or an
exact immutable release tag such as `v4.0.0`.

The release transaction is fail-closed. The v4 provider-operation journal,
activation plan, stable publication fence, and partial-mutation recovery plan
bind the exact source, qualification, policy, provider readback, protected
ancestry, and target roots. Confirmed operations are never replayed; uncertain
operations require provider readback before retry; stable publication requires
an N-1 or independently sealed qualification.

## Provider readback

A stable release is complete only when all of these coordinates agree:

- `release/v4/v4.0`, `v4`, `v4.0`, and the exact `v4.0.x` tag;
- the GitHub Release tag and attached Release Passport evidence;
- npm `@kungfu-tech/buildchain@4.0.x`, its `gitHead`, and the `latest` tag;
- the protected source and release transaction roots.

The alpha channel applies the same rule to `alpha/v4/v4.0`, `v4-alpha`, the
exact alpha tag, and npm's `alpha` tag.

## Non-destructive rollback

Rollback never rewrites an exact tag, release, package version, Passport, or
provider journal. Stop forward promotion, pin consumers to the last verified
exact v4 SHA or exact stable tag, and use the retained `release/v3/v3.0`
coordinate only as an explicit compatibility rollback reference. Restoring v3
as production authority requires a new reviewed cutover; it is not an implicit
fallback.

Before any retry, compare the current provider state with the retained
transaction and operation roots. Resume only missing eligible operations.
Conflicting state remains `repair-required` or terminal and must not be
converted into success by moving a floating ref.
