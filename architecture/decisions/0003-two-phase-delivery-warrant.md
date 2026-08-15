---
status: accepted
period: 2026-08-11
theme: two-phase-delivery-warrant
doc_type: architecture-decision-record
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-13
---

# ADR 0003: Delivery Order Is Reserved Before Native Qualification

## Status

Accepted. This decision is normative for the v3 Delivery Warrant state machine,
reusable delivery workflows, and generated native consumer workflows.

## Context

A slow native pull request can pass source acceptance, obtain approval, and then
spend long enough in platform qualification for the protected dev base to move
many times. Requiring all native shards to finish before the pull request owns
a delivery turn permits a stream of later fast candidates to overtake it.
Freezing dev or disabling protection would avoid the race only by stopping
unrelated work or removing the authority that must be proven.

Native evidence also has two identities that must not be conflated. Semantic
source, affected closure, dependency graph, and toolchain determine whether a
native result remains valid. The current dev commit and replay tree determine
the final integration composition. A dev-only documentation change should not
invalidate semantic native evidence, while a change inside the affected closure
must never be silently reused.

## Decision

Delivery Warrant ownership has two phases:

```text
queued -> provisional --native proof accepted--> qualified -> GitHub merge queue
              |                  |
              +--failure--------+--> terminal release -> wake next candidate
              +--expiry------------> recovered queue entry with a new fence
```

Source acceptance, the ready label, current approval, and required source checks
are established before selection. Selection issues a `provisional` Warrant with
one TTL, heartbeat protocol, lease generation, and fencing token. It reserves
the next protected-dev delivery turn but is not merge-queue authority. Later
pull requests may run source and CI work and remain visible in the durable FIFO
plus aging queue; none may enter the protected merge queue while another exact
candidate owns the active Warrant.

Native success upgrades the same fenced generation atomically to `qualified`.
The transition binds a Native Qualification Proof and a rooted reuse decision.
Only a qualified Warrant may authorize enqueue. The upgrade does not mint a new
fence and cannot change the PR head or semantic source roots.

Native Qualification Proof v3 binds semantic source identity, semantic patch,
qualification plan, affected closure, dependency graph, toolchain, execution
environment contract, covered paths, exact shard evidence roots, the dev base
used for qualification, and the exact native execution receipt. That receipt
contains the normalized repository, protected base, source head, qualified
base, toolchain root, and environment root binding established before the
native process starts. The proof repeats and roots that binding, and includes
the receipt root in its shard evidence. Its
timestamp is observational rather than part of proof identity. Reuse on another
base requires an attributed base delta. Identical base is accepted directly; a
descendant base with no overlap against the affected closure reuses the proof;
overlap requires affected or full native revalidation; unknown ancestry,
truncated attribution, semantic change, closure change, dependency change, or
toolchain change requires full revalidation.

The reusable controller composes the exact PR head with the observed protected
base before running native work, heartbeats while the command is active, and
checks base drift after completion. It may perform one automatic revalidation
on the latest base. Continued overlapping drift fails closed. Native failure,
cancel, semantic head movement, unrecoverable composition conflict, or exhausted
revalidation closes only the current fence. The controller then emits a rooted
`buildchain-dev-delivery-wake` repository event for the next queued candidate.
Cancellation that prevents cleanup is covered by TTL recovery; the stale worker
cannot renew or qualify after a new fence is minted.

GitHub `merge_group` checks and the protected dev ref remain final integration
authority. No transition disables a check, changes branch protection, force
updates the Warrant ref, or freezes dev.

Required native delivery validates the environment root before candidate
submission, Warrant selection, checkout/composition, or native process spawn.
An empty or malformed root is therefore an admission failure, not a terminal
failure after native capacity has been spent. `off`, `shadow`, and
`non-native-fast` compatibility does not turn the reusable workflow input into
an unconditional requirement.

## Compatibility

Existing v1 queue documents remain readable. An historical active Warrant that
does not contain `phase` is interpreted as the former already-qualified shape
without rewriting its state root. Newly selected Warrants always contain
`phase: provisional`. Existing `off` and `shadow` workflow modes remain
available; `required` now enforces the two-phase upgrade. Native Qualification
Proof v1 and v2 documents remain verifiable as historical evidence, but their
execution receipts do not bind the environment root. They cannot gain v3 exact
reuse authority and must be replaced by an explicit native revalidation.

## Consequences

- Slow approved candidates stop starving without serializing development or CI.
- A provisional receipt is intentionally insufficient for merge admission.
- Base-only replay churn can reuse native evidence when closure attribution is
  complete and disjoint.
- Overlap and uncertainty spend more native compute but cannot create an
  unproven protected-dev landing.
- Consumers need a promotion token that can advance the Warrant state ref and
  emit the wake event, plus a native command or an exact reusable proof.
- Invalid required-native environment inputs fail before they can allocate a
  Warrant or native runner time.
- Legacy unbound native evidence remains readable but intentionally spends a
  new validation run before qualification.
