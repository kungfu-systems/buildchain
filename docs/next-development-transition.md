---
status: preview
period: ongoing
theme: next-development-transition
doc_type: generated-contract-guidance
source_level: generated-from-node-contract
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-11
---

# Next-development Transition

This document is generated from
`packages/core/next-development-transition.js` and
`packages/core/next-development-projection.js`. Edit those sources and run
`node scripts/generate-next-development-guidance.mjs`; direct edits fail the
projection drift check.

## Contract

- Contract: `kungfu-buildchain-next-development-transition/v1`
- ADR: [ADR 0002](../architecture/decisions/0002-next-development-transition.md)
- States: `planned`, `waiting-anchor`, `materialized`, `pr-pending`, `merged`, `verified`
- Legal version models: `semver/auto` and `anchored/manual`
- Invariant: A completed Alpha remains successful and its refs remain immutable while the next-development transition is incomplete.

An Alpha publication is terminal success independently of this transition.
The idempotency key is a deterministic hash of the completed-Alpha root,
repository, legal model, and sorted declared paths. Incomplete Dev preparation
therefore cannot relabel Alpha N as failed, and replay cannot select a different
Alpha or path set.

## Version models

`semver/auto` increments the Alpha sequence on the same semantic patch. For
example, completed `1.4.2-alpha.7` plans `1.4.2-alpha.8`. It must not accept an anchor or an
operator-selected target.

`anchored/manual` enters `waiting-anchor` until the caller provides both a
semantic target and the exact digest of the configured anchor manifest. The
adapter verifies the manifest already present in the checkout; it never invents
or edits upstream anchor facts. `semver/manual` and `anchored/auto` are
invalid.

## Local adapter

From a normal Buildchain checkout:

```sh
node scripts/next-development-transition.mjs materialize --cwd . --input <request.json>
```

The command prints a rooted plan and performs no write by default. `--write`
may change only regular, non-symlink source files listed by `version.files`
in the loaded Buildchain config. The rooted adapter contract separately names
`version.derived_files` as allowed changes, `version.manifest` as read-only,
`BUILDCHAIN_VERSION` as the target input, `lifecycle.version-state` as the
derived-material stage, and `lifecycle.verify` as the truth gate. The
reference writer fails closed when derived files exist because transaction
execution is outside this contract slice. It performs no Git operation, ref
update, network request, provider call, lifecycle command, or anchor edit.

Preparing development state creates no tag, Release, public package, or
candidate. Those public effects remain outside the local adapter contract.

The request schema is
`contracts/next-development-request-v1.schema.json`; the durable record schema
is `contracts/next-development-transition-v1.schema.json`. Positive and
negative examples live under
`contracts/fixtures/next-development-transition-v1/`.
