---
status: draft
period: 2026-08-07
theme: buildchain-v4-architecture-constitution
doc_type: architecture-constitution
source_level: local-files + protected-git-evidence
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-13
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-07
  boundary: Derived from the exact v3 mechanism inventory, retained v4 qualification evidence, and visible repository contracts; provider credentials and private provider state were not read.
---

# Buildchain v4 Architecture Constitution

This constitution governs the `dev/v4/v4.0` release line. The executable
authority is [`v4-capability-state-machine-manifest.json`](v4-capability-state-machine-manifest.json),
validated by `buildchain architecture validate`. This document explains that
contract; it cannot override it.

## 1. Release-line authority

The first v4 line was created from the exact protected v3 merge that contains
this constitution and
[`v4-bootstrap-authority.json`](v4-bootstrap-authority.json). The exact source,
bootstrap revision, N-1 qualification, protection, and merge-queue evidence are
recorded there under the state `qualified-protected-v4-bootstrap`; a local
branch or unrecorded candidate commit is not release-line authority.

Later v4 candidates are qualified by an exact N-1 Git revision. The verifier
loads the authority files with `git show <authority-revision>:<path>` and rejects
an authority revision equal to the candidate revision. A candidate therefore
cannot qualify itself by editing its own manifest, ceilings, or exception
ledger.

## 2. Dependency direction

Dependencies point inward only:

```text
workflows -> TypeScript adapters -> libnode host -> Rust domain -> contracts
legacy compatibility -> TypeScript adapters / contracts
```

Contracts contain serialization and compatibility facts, not provider SDK
types. Rust domain code contains semantic state transitions, not GitHub, npm,
filesystem, credential, or workflow adapters. Provider SDK imports in contracts
or Rust domain are hard-zero violations. Cycles are forbidden.

## 3. Single-writer rule

Every state machine has exactly one authoritative writer. The v4 cutover marks
the TypeScript v4 control and provider plane authoritative and the legacy v3
writer retired. Rust v4 owns the deterministic release-activation, journal,
stable-fence, and recovery domain semantics while the TypeScript v4 adapter
remains byte-equivalent at that boundary. A second writer, permanent dual
write, cross-machine mutable file, or implicit compatibility authority has a
hard-zero budget.

## 4. Explicit complexity budgets

Complexity is governed by independent dimensions: authority, semantic state,
boundary, structural, Agent cognitive, and recovery/fault. There is no
aggregate score, so a favorable metric cannot cancel an authority or recovery
violation. Every delta is reported by dimension.

Hard-zero ceilings cannot be raised by a candidate. A non-zero temporary
exception must already exist in the N-1 authority ledger and name its owner,
scope, evidence, expiry, removal condition, and budget dimension. Expired,
ownerless, broadened, or candidate-created exceptions fail qualification.

## 5. Manifest and projection

The manifest declares capability ownership and every governed state machine's
writer, schemas, store, states, events, invariants, effects, adapters, tests,
migration phase, recovery policy, and budgets. `architecture list` and
`architecture show` are generated directly from the validated manifest; no
second hand-maintained architecture list is authoritative.

## 6. Production cutover boundary

The v4 line owns Delivery Warrant, Release Transaction, activation,
publication, propagation, and release-tail state. This does not introduce a
daemon, a service database, provider SDKs in contracts or Rust domain code, or
a second writer. The retained `release/v3/v3.0` coordinate is rollback evidence
only and cannot regain production authority without a new reviewed cutover.

## 7. Wave 0 host boundary

The bounded Rust/libnode bridge spike is recorded in
[`v4-rust-libnode-bridge-spike.md`](v4-rust-libnode-bridge-spike.md). Wave 0
uses a replaceable subprocess host behind a closed byte-oriented contract; the
Rust trunk owns process lifecycle and transport, while existing TypeScript
remains the only production writer. This selection is evidence for later
qualification, not a final ABI or consumer migration.

## 8. Wave 2 Stage Capsule contract

The executable Stage Capsule architecture contract is
[`v4-stage-capsule-contract.json`](v4-stage-capsule-contract.json). It fixes one
schema authority, one TypeScript v3 writer, validation-only Rust, and zero
provider imports or production write-authority changes. Identity, retention
promise, current availability, qualification, content roots, and rooted
transport observations remain distinct. Later store, checkpoint, resume, and
reconciliation work must consume this contract rather than create competing
identity or writer authority.

The successor storage slice is governed by
[`v4-stage-capsule-store-contract.json`](v4-stage-capsule-store-contract.json).
It adds provider-neutral output-manifest, retention-state, transport, and store
receipt roots plus a deterministic no-network local filesystem reference
store. GitHub Artifact and S3-compatible adapters remain effect-disabled or
fixture-backed. Provider locations, retention promises, observed availability,
and qualification evidence stay separate facts; none becomes Capsule identity,
qualification authority, or a production writer.

Final Wave 2 qualification is governed by
[`v4-stage-capsule-qualification.json`](v4-stage-capsule-qualification.json).
It consumes the existing Capsule, store, checkpoint, and resume authorities for
six real-runner shadow campaigns and one exact terminal reconciliation. A
qualification root is evidence only: TypeScript v3 remains production
authority, retained state is non-destructive, and production reuse, provider
effects, release effects, and public cutover remain outside this transition.

## 9. Wave 3 provider operation journal

The executable provider operation journal contract is
[`v4-provider-operation-journal-contract.json`](v4-provider-operation-journal-contract.json).
It freezes one closed schema authority and one Rust v4 state-fold authority
for append-only intent, attempt, rooted observation, confirmation, and
reconciliation records. The TypeScript v4 plane performs provider adaptation
and conformance projection against the same fixtures; v4 is the sole
production writer.

Logical operation identity excludes attempt ordinals and mutable provider or
runner facts. Every retry preserves `operationRoot`, while every attempt and
observation has a distinct causal entry root. The fold rejects impossible
transitions, non-append sequence, confirmation without successful rooted
observation, conflicting confirmation, reconciliation disagreement, and
authority-root escalation. Provider SDK imports, live mutations, production
write-authority changes, and v3 behavior changes retain hard-zero budgets.

GitHub release, npm publication, and OCI manifest readback adapters remain
fixture-backed and effect-disabled. They discard provider-shaped transport
fields at the boundary and emit only rooted, provider-neutral samples. Duplicate
and reordered samples fold by byte-sorted sample root into one journal
observation. Not-found and eventually-visible reads stay unknown; already
applied reads may become a successful observation, but no adapter may confirm
the operation or advance release state without independent journal
qualification. Conflicting, malformed, and root-mismatched evidence fails
closed with typed faults.

## 10. Release activation production domain

The executable release activation boundary is
[`v4-release-activation-shadow-domain.json`](v4-release-activation-shadow-domain.json).
It consumes an explicit qualification root, dependency graph, compensation
boundaries, provider-operation identities, and append-only journal facts to
derive one deterministic activation plan and resume state. Rust is the sole v4
plan-and-fold authority; TypeScript must remain byte-equivalent against
the same closed schema and fixture.

Confirmed operations are never eligible for replay. Attempting, observed, and
confirmable operations require provider-neutral readback before any retry,
while planned or retryable operations become eligible only after every declared
dependency is confirmed. Missing qualification, dependency cycles, operation or
authority drift, conflicting event ordinals, and impossible journal transitions
fail closed. This pure domain performs no provider call itself; the TypeScript
v4 provider adapter may execute only exact eligible operations and must append
rooted readback before confirmation or retry.

## 11. Stable publication production fence

The stable-candidate production publication boundary is governed by
[`v4-stable-publication-fence.json`](v4-stable-publication-fence.json). It
binds one exact candidate root to source, metadata, provider-operation journal,
protected ancestry, provider confirmations, and an independently sealed
qualification before a production publication plan can exist.

Candidate generation N cannot qualify itself. An N-1 policy requires the
immediately preceding authority generation; an independent-seal policy requires
a qualifier authority distinct from the publisher authority. Stable refs, npm
tags, OCI tags, and GitHub Releases remain exact target-shaped facts. The pure
fence authorizes the exact target count but performs no network or credential
operation itself; only the TypeScript v4 provider adapter may apply authorized
targets, and it must read them back before completion.

## 12. Wave 3 partial-mutation recovery qualification

The executable recovery qualification boundary is
[`v4-partial-mutation-recovery-qualification.json`](v4-partial-mutation-recovery-qualification.json).
It consumes retained Stage Capsule resume evidence and release-activation journal
state only after exact source, policy, platform, qualification, plan, state,
operation, journal, and compensation-boundary roots agree.

Every nonterminal operation maps deterministically to `retry`, `wait`,
`reconcile`, `compensate`, or `escalate`; confirmed operations are permanent
`terminal-noop` facts and never re-enter the next-operation set. Missing,
expired, corrupt, conflicting, cross-boundary, or attempt-budget-exhausted
evidence fails closed at an exact Stage Capsule or provider-operation
checkpoint. The Rust domain is the sole v4 planner and TypeScript is a
byte-equivalent projection. Both are pure: they perform zero provider,
filesystem, network, credential, ref, package, image, or release mutation.
Their exact plan is the only recovery authority consumed by the TypeScript v4
provider adapter.
