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
`packages/core/next-development-controller.js` and
`packages/core/next-development-projection.js`. Edit those sources and run
`node scripts/generate-next-development-guidance.mjs`; direct edits fail the
projection drift check.

## Contract

- Contract: `kungfu-buildchain-next-development-transition/v1`
- Durable controller: `kungfu-buildchain-next-development-controller/v1`
- ADR: [ADR 0002](../architecture/decisions/0002-next-development-transition.md)
- States: `planned`, `waiting-anchor`, `materialized`, `pr-pending`, `merged`, `verified`
- Legal version models: `semver/auto` and `anchored/manual`
- Invariant: A completed Alpha remains successful and its refs remain immutable while the next-development transition is incomplete.

An Alpha publication is terminal success independently of this transition.
The idempotency key is a deterministic hash of the completed-Alpha root,
repository, legal model, and sorted declared paths. Incomplete Dev preparation
therefore cannot relabel Alpha N as failed, and replay cannot select a different
Alpha or path set.

## Durable controller

`scheduleNextDevelopmentController` atomically creates one child for the
repository and completed-Alpha root. Identical wakes reuse it. The store
boundary requires read, create-if-absent, and compare-and-swap operations; the
controller root fences every checkpoint. Materialization uses an operation key
derived from the child, exact current protected Dev SHA, and reviewed target,
so a fresh runner can recover an already-created commit instead of rebuilding
the Alpha candidate or depending on the original runner workspace.

Before opening the protected version PR, the controller reads Dev again. A
moved head makes the prepared attempt `superseded`; the following wake
regenerates only declared version material from that latest SHA. After merge,
`verified` remains unreachable until protected Dev readback contains the
prepared commit and its target version, source roots, and derived roots exactly
match the checkpoint. The executor surface contains no Alpha publication, tag,
release, or package operation.

Alpha finalization no longer treats a non-fast-forward Dev update as successful
bookkeeping. It requires an exact checkout of the current Dev head, regenerates
the declared version lifecycle there, and uses a non-force merge or reusable
protected version PR. Candidate Patrol ignores both the generated preparation
commit and its two-parent integration commit. Before a later product candidate
can settle, Patrol reads every prepared version path at the candidate SHA and
requires the exact reserved blob identities; missing or stale state blocks
before a Release Cut or heavy candidate build.

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
