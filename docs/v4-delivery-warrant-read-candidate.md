---
status: draft
period: ongoing
theme: buildchain-v4-delivery-warrant
doc_type: contract-guide
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-08
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-08
  invisible_context: not asserted
---

# Delivery Warrant v4 read candidate

The v4 read candidate is an explicit, reversible observation path. TypeScript
v3 remains the sole production writer, queue store owner, rollback authority,
and provider adapter. Rust receives canonical state bytes, validates the pure v4
state contract, and returns a read-only projection with effects disabled.

The normal `observe` path defaults to `--read-mode v3`. No mutation command
consults the read switch. A caller may select v4 only by supplying all of the
following:

- a retained, self-root-verifying semantic-diff report;
- the exact expected report root;
- the report's exact TypeScript revision, Rust revision, and validator version;
- a caller-owned evidence output.

The candidate fails closed on a blocked, expired, missing, or drifted
qualification; source mismatch; unsupported host capability; crash; timeout;
cancellation; malformed response; state/root disagreement; or evidence
retention failure. It never silently falls back inside a v4 request. Rollback
is the explicit caller change back to `--read-mode v3`, which avoids dual read
authority and leaves the v3 queue untouched.

## Source-checkout invocation

The preview candidate runs against the checked-out Rust contract host:

```sh
buildchain dev warrant observe \
  --repository owner/repository --branch dev/v4/v4.0 \
  --read-mode v4 \
  --read-qualification semantic-diff-report.json \
  --read-qualification-root sha256:<root> \
  --read-typescript-revision <sha> \
  --read-rust-revision <sha> \
  --read-validator-version semantic-diff-gate-v1 \
  --read-evidence-output .buildchain/dev-delivery/v4-read-evidence.json
```

The returned command result keeps the existing v3 observation schema for
caller compatibility and adds `readCandidate` evidence that fixes
`writerAuthority=typescript-v3`, `rustAuthority=read-only`,
`rustEffects=disabled`, `rollbackMode=v3`, both state roots, the qualification
root, and the retained evidence receipt root.

Focused verification:

```sh
node --test tests/v4-delivery-warrant-read-candidate.test.mjs
pnpm run check:v4-contracts
```

This candidate does not authorize a v4 write cutover. Protected-window parity,
independent review, and the rollback drill remain required exit evidence for
the read stage.
