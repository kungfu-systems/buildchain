---
status: accepted
period: ongoing
theme: dev-delivery-qualification-landing-authority
doc_type: architecture-decision-record
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-12
---

# ADR: Qualification Leases and the exclusive Landing Warrant

## Decision

Buildchain has two explicit protected-dev authority modes:

1. `single-flight-warrant` is the default and continues to use the
   `kungfu-buildchain-dev-delivery-warrant-queue` v1 state and
   `buildchain dev warrant` commands unchanged.
2. `bounded-qualification-landing` is opt-in and uses the
   `kungfu-buildchain-dev-delivery-authority` v2 state. It may issue up to the
   configured number of Qualification Leases, but it may issue exactly one
   Landing Warrant.

The modes use different contracts, state refs, and CLI command families. There
is no implicit reinterpretation of a v1 Warrant. A consumer turns the new mode
on only by explicitly migrating the exact current v1 state and deploying the
v2 controller against the dedicated
`buildchain/dev-delivery-authority/<dev-line>` state ref.

Migration preserves the immutable v1 `stateRoot`, candidate identity, source
and proof roots, fencing token, generation, and lease times in a rooted
migration receipt. An active provisional Warrant becomes a
qualification-only lease and remains unable to admit `merge_group`; an active
qualified Warrant becomes the one exclusive Landing Warrant. The migration is
one-shot: a v2 state is never accepted as v1 input, and source/evidence bytes
are not regenerated. The legacy ref remains immutable rollback evidence.

## Authority invariants

A Qualification Lease carries:

- `authority = qualification-only`;
- `mergeGroupAdmission = false`;
- one exact candidate id, token, generation, issue time, and expiry; and
- a place in a list bounded by `policy.maxQualificationLeases`.

It authorizes expensive qualification work only. It cannot authorize GitHub
`merge_group`, cannot be upgraded in place to landing authority, and is removed
when qualification evidence is recorded.

The Landing Warrant carries:

- `authority = merge-group-admission`;
- `mergeGroupAdmission = true`;
- one exact qualified candidate id, token, generation, issue time, and expiry;
  and
- the only non-null `landingWarrant` slot in the durable state.

Only `admitDevDeliveryMergeGroup` and `buildchain dev authority
admit-merge-group` consume Landing authority. They bind the exact current state
root, candidate, protected base, source head, merge-group head, token, and
generation. A Qualification Lease fails closed at this boundary.

The state normalizer rejects a lease beyond the configured bound, duplicate
Qualification Leases for one candidate, a candidate holding qualification and
Landing authority together, a Landing Warrant without its exact landing
candidate, and any state-root drift. Git expected-old, non-force ref advancement
continues to serialize durable mutations. These checks retain the existing
two-phase safety rule: source/native qualification is evidence, while the
exclusive final authority is candidate- and integration-specific.

## Terminal settlement

Terminal provider evidence is authoritative cleanup input. A matching merged,
failed, dequeued, or cancelled candidate releases its Qualification Lease or
Landing Warrant in the same expected-old state transition, even when the lease
TTL has not expired. An active authority requires its exact token and
generation for that transition. Repeating the same outcome and evidence is a
root-preserving no-op; outcome or evidence drift fails closed. A terminal event
for a candidate that never entered the state is also an explicit no-op.

TTL recovery remains crash recovery, not the normal terminal cleanup path.

## Public contract

- Machine schema:
  [`contracts/dev-delivery-authority-v2.schema.json`](../contracts/dev-delivery-authority-v2.schema.json),
  packaged as `dist/site/schemas/dev-delivery-authority-v2.schema.json`.
- Node API: `@kungfu-tech/buildchain/dev-delivery-authority` exports the v2
  state, migration, lease, Landing, admission, observation, and settlement
  functions. `@kungfu-tech/buildchain/dev-delivery-warrant` remains byte- and
  behavior-compatible for v1 consumers.
- CLI: `buildchain dev authority
<migrate|submit|lease-qualification|complete-qualification|lease-landing|admit-merge-group|settle|observe>`.
- Generated references: [`cli-reference.md`](cli-reference.md) and
  [`node-api-reference.md`](node-api-reference.md).

All mutations are plan-only unless `--execute` is supplied. Merge-group
admission is always a read-only authority check; it never mutates GitHub Merge
Queue itself.

## Consequences

Qualification throughput can increase without increasing the number of
candidates permitted to land. Consumers retain the byte- and behavior-compatible
single-flight default until they deliberately deploy the v2 mode. The tradeoff
is a second state contract and controller family; Buildchain keeps that
separation explicit so a rollout cannot silently weaken Warrant semantics.
