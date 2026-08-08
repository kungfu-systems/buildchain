---
status: draft
period: ongoing
theme: buildchain-v4-delivery-warrant
doc_type: architecture-plan
source_level: local-files-and-public-evidence
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-07
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-07
  invisible_context: not asserted
---

# Delivery Warrant v4 Shadow and Bootstrap Plan

This plan makes the current Delivery Warrant behavior implementable as a
provider-free Rust domain without changing production authority. The normative
machine-readable plan is
[`v4-delivery-warrant-shadow-bootstrap-plan.json`](./v4-delivery-warrant-shadow-bootstrap-plan.json).
The shared traces and frozen JavaScript projection roots are in
[`v4-delivery-warrant-shadow-fixtures.json`](./v4-delivery-warrant-shadow-fixtures.json).

## Decision

TypeScript v3 remains the sole production writer through shadow and v4-read.
Rust may decide and fold the same canonical events, but it emits only a
non-authoritative projection until an independently reviewed protected revision
passes every write-cutover gate. At cutover there is still one authority: Rust
owns pure decision/fold and one TypeScript adapter owns ordered effects. A
per-request authority switch and permanent dual writes are forbidden.

The bootstrap authority is exact, not narrative:

- v3 authority revision: `b9fbfd9d6ee909ee3a8c4bd6116e7ddafd7b05e1`
- qualified v4 bootstrap revision: `d827bb223e4b78551feed69827f3e67839821171`
- qualification root:
  `sha256:ea58bf84bd8ba32d0d7931328a2209f937bd3b81d3215b27f2ca67abc704a673`
- candidate self-qualification: forbidden
- later authority: the exact prior qualified protected v4 revision (N-1)

## Source audit

The plan is grounded at repository revision
`3fd14c7a6237c3a1709ce29fc9fcb4ac150a0e5d` and preserves the current v3
inventory rather than reconstructing it from workflow prose.

| Concern                                          | Source of record                                                                   | Result                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Current states, events, writers, stores, effects | `v3-core-mechanism-inventory.json` and `v4-capability-state-machine-manifest.json` | Nine states, seven manifest events, TypeScript v3 sole writer                |
| Queue roots, generation, selection, leases       | `packages/core/dev-delivery-warrant.js`                                            | Rooted successors, bounded FIFO/aging, one active fence                      |
| Terminal behavior                                | settlement and cancellation modules plus Warrant tests                             | Active fenced close, exact queued cancellation, terminal/no-authority no-ops |
| Durable compare-and-set                          | `scripts/dev-delivery-warrant.mjs`                                                 | Immutable Git commit plus expected commit/root readback                      |
| Protected effects                                | Buildchain dev delivery, close, and cancel workflows                               | GitHub admission occurs after exact state readback                           |
| Bootstrap and N-1                                | `v4-bootstrap-authority.json` and `v4-architecture.mjs`                            | v3 bootstrap authority, protected v4 handoff, no self-qualification          |

Public state-ref observations at the source audit showed an idle v4 queue at
generation 9/fencing counter 3 and an idle v3 queue at generation 103/fencing
counter 32. The history includes real expiry recovery and retained attempts,
not only unit fixtures. Protected delivery evidence includes successful runs
for [PR 2420](https://github.com/kungfu-systems/buildchain/actions/runs/31155672200)
and [PR 2421](https://github.com/kungfu-systems/buildchain/actions/runs/31154367136),
plus fail-closed attempts where admission or source identity disagreed before a
later corrected run. These observations are evidence samples, not a new
authority source.

## Transition semantics

The JSON plan is the complete matrix. Each row freezes source states, guards,
generation behavior, fencing, clock, roots, errors, recovery, and idempotence.
The important semantic distinctions are:

| Event              | Authoritative result                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `submit`           | Append a candidate, safely repair the same attempt's head while retaining age, or append a chained attempt after terminal history. The legacy duplicate receipt says no-op but still changes queue time/generation/root. |
| `select` / `lease` | Recover expiry first, retain a live active Warrant non-preemptively, otherwise deterministically select and mint the next fence. `lease` is a manifest alias, not a second operation.                                    |
| `renew`            | Require the exact live candidate, fencing token, lease generation, and unexpired lease; extend expiry and project the candidate to `proving`.                                                                            |
| `recover-expired`  | Reject the old fence, retain enqueue age, increment attempts/recoveries, and return to `queued`.                                                                                                                         |
| `settle`           | Close an active exact fence, cancel an exact queued candidate, accept an exact terminal duplicate, or report a rooted never-admitted no-op.                                                                              |
| `cancel`           | Cancel only an exact queued candidate without minting a Warrant; active states must use fenced settlement.                                                                                                               |

`waiting` and `blocked` are accepted active states but have no exported legacy
transition that enters them. This is a cutover blocker: Wave 1 must add explicit
events or remove those states through a protected manifest change. The plan
does not invent missing behavior.

## Canonical core and boundary

Wave 1 implements nine reusable primitives: canonical JSON, content roots,
expected-old comparison, explicit clock, decide/fold, declarative effects,
provider-neutral observations, typed bounded retry, and rooted receipts.

Canonical JSON v1 is deliberately narrow: schemas use ASCII property names and
integer numbers; object keys use ASCII code-point order; arrays preserve order;
JSON bytes are UTF-8 and end with one LF. This makes JavaScript/Rust fixtures
portable while exposing the legacy `localeCompare` key ordering as an explicit
disagreement. The queue root excludes its `stateRoot` member.

Rust domain code may import canonical contracts, hashing, and time value types.
It may not import provider SDKs, access the network/filesystem, or sample an
ambient clock. TypeScript adapters sample time once, execute Git/GitHub effects,
perform exact readback, enforce retry budgets, and retain evidence.

## Shadow and fault proof

Both implementations consume the same fixture bytes. The semantic projection
compares decisions/errors, successor queue bytes and roots, generation/fencing,
ordered effects, and receipt bytes/roots. The checked-in fixture suite covers:

- submission, duplicate submission, priority selection, renewal, and close;
- lease expiry, reselection, and rejection of the stale fence;
- never-admitted settlement, active settlement, and terminal duplicate;
- queued cancellation and exact duplicate cancellation;
- accepted and stale expected-old checks, response-loss readback, and provider
  conflict stop behavior.

A gate is zero-diff only when every required fixture and captured production
replay has no unexplained semantic difference. Replay inputs, both projections,
the diff, source revisions, and validator version are retained for 90 days.
Provider conflict or indeterminate readback stops; it never manufactures state.

The executable gate and its closed report contract are documented in
[`v4-delivery-warrant-semantic-diff.md`](../docs/v4-delivery-warrant-semantic-diff.md).
It adds bounded property traces and fault probes around the paired shadow
observation. A passing report only opens the reversible v4-read candidate; its
write-authorization field is permanently false.

## Bootstrap, cutover, and rollback

| Stage                        | Sole authority                                      | Exit evidence                                                             | Rollback                                                         |
| ---------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Legacy-authoritative shadow  | TypeScript v3                                       | Fixture and captured-replay zero-diff; fault injection                    | Disable Rust invocation; queue unchanged                         |
| Legacy-authoritative v4 read | TypeScript v3                                       | One protected-release window of read parity; rollback drill               | Route reads to v3                                                |
| v4-authoritative write       | Rust decide/fold plus one TypeScript effect adapter | Cutover receipt, single-writer proof, exact readback, response-loss drill | Stop v4, restore exact pre-cutover v3 root and retained receipts |
| Legacy removal               | Rust decide/fold plus one TypeScript effect adapter | No legacy callers; history replayable; N-1 fallback is protected v4       | Revert to exact prior qualified protected v4 revision            |

Every stage has explicit entry, exit, evidence, rollback, and stop conditions in
the JSON plan. A rollback chooses one last-known-qualified writer for the whole
protected line. It never creates permanent dual authority.

## Wave 1 entry

Wave 0 reconciliation proves the four protected child deliveries and opens the
implementation entry for Wave 1. The earlier wording made the whole wave depend
on the zero-diff gate even though that gate is produced by the wave itself; that
circular gate is invalidated. Zero-diff remains mandatory specifically before
the reversible v4-read candidate.

The dependency order is canonical contracts, shared fixture runner, Rust pure
domain and TypeScript shadow adapter, semantic-diff gate, then the read
candidate. The first five nodes do not move authority. Rust writer effects,
Release Transaction, Candidate Capsule, resume planning, consumer migration,
and actual provider effects remain out of scope.

## Wave 0 reconciliation

The machine-readable plan records exact protected PR, source, merge, review,
and check evidence for the inventory, constitution, bridge spike, and Warrant
plan. All four deliveries are proved. The Initiative matrix is deliberately
stricter than child completion: the Agent state/explain/plan interface and
cross-platform bridge evidence are partial, while resumable release, self
dogfood, migration, legacy removal, and final v4 qualification are missing.
TypeScript v3 remains the sole production authority throughout.

## Verification

Run the focused contract and fixture checks with:

```sh
node scripts/v4-warrant-shadow-plan.mjs validate
node --test tests/v4-warrant-shadow-plan.test.mjs
node scripts/v4-architecture.mjs validate
```

The repository `check` command runs the plan validator and the unit suite. A
protected design PR must also pass schema/format checks, independent review,
exact N-1 qualification, and the existing architecture gate.
