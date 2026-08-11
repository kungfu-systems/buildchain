---
status: accepted
period: 2026-08-11
theme: next-development-transition
doc_type: architecture-decision-record
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-11
---

# ADR 0002: Alpha Publication and Next-development Are Separate Transactions

## Status

Accepted. This decision is normative for Buildchain promotion controllers and
for generated consumer guidance.

## Context

An Alpha publication and preparation of the following development version have
different trust boundaries. Alpha publication establishes public, immutable
facts about version N. Preparing N+1 changes repository version material and
may require a protected pull request or an upstream anchor that does not exist
when Alpha N completes. Treating both operations as one success condition makes
a post-publication conflict appear to invalidate a publication that already
succeeded, and encourages retries to move Alpha refs while repairing Dev.

Buildchain supports two legal version models:

- `semver` with `next = "auto"`, where N+1 increments the Alpha sequence on
  the same semantic patch; and
- `anchored` with `next = "manual"`, where no version may be inferred before a
  declared anchor manifest is materialized and rooted.

The crossed combinations `semver/manual` and `anchored/auto` have no defined
meaning and are rejected.

## Decision

Alpha publication reaches its own terminal success before a next-development
transition is created. The transition records the completed Alpha exact tag,
release commit, tree, publication evidence root, and completion time. A
deterministic idempotency key covers that completed-Alpha root together with
the repository, legal version model, and the role-separated adapter path set.

The independent next-development state machine is:

```text
planned ----------------------> materialized -> pr-pending -> merged -> verified
   \                              \---------------------------> merged
    -> waiting-anchor ----------> materialized
```

`semver/auto` derives its target while planned. `anchored/manual` remains in
`waiting-anchor` until an exact semantic version and the digest of the declared
anchor manifest are supplied. `pr-pending` is durable incomplete state, not a
publication failure. Direct materialization may proceed to `merged` or
`verified` when repository governance does not require a pull request.

Every non-initial state transition is compare-and-swap guarded and rooted in
explicit evidence. Replaying an identical request is a no-op. Alpha outcome is
always `preserved-success`; no transition may write an Alpha branch, exact tag,
or floating tag. A controller that needs to repair next-development state may
write only paths declared by `version.files` and `version.derived_files`; the
configured anchor manifest is declared read-only authority.

## Local adapter boundary

The reference adapter is provider-neutral. It reads the checked-in
`buildchain.toml`, derives the sorted path allowlist, validates the completed
Alpha and optional anchor, and plans version-file content. It never invokes Git,
network clients, lifecycle commands, package registries, or provider APIs.
Mutation requires explicit `--write`, rejects symlinks and path escapes, and is
limited to configured `version.files`. The standard repository transaction
adapter passes the exact target in `BUILDCHAIN_VERSION`, permits changes only
to `version.files` plus `version.derived_files`, runs
`lifecycle.version-state` when derived files are declared, and then runs
`lifecycle.verify`. The reference writer fails closed rather than invoking
those consumer commands because transaction execution is a separate slice.
For anchored/manual, the consumer must
materialize the declared manifest first; the adapter verifies its exact digest
and does not invent or edit upstream anchor data.

Preparing development state alone creates no Git tag, GitHub Release, public
package, or release candidate.

## Consequences

- A completed Alpha N remains successful when N+1 waits for an anchor, a
  protected PR, merge, or verification.
- Retrying development preparation cannot republish Alpha N or change any
  Alpha ref.
- Semver and anchored consumers share one lifecycle while retaining their
  distinct version authority.
- Provider adapters may project pull-request identifiers and merge evidence,
  but those observations do not become part of the local mutation authority.
- Generated config, Agent instructions, and public documentation are checked
  against the same constants; projection drift fails repository checks.
