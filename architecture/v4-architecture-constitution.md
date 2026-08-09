---
status: draft
period: 2026-08-07
theme: buildchain-v4-architecture-constitution
doc_type: architecture-constitution
source_level: local-files + protected-git-evidence
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-09
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-07
  boundary: Derived from the exact v3 mechanism inventory and visible repository contracts; no production writer migration is claimed.
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

Every state machine has exactly one authoritative writer. Wave 0 keeps all
production writers on v3. Rust may validate, replay, or emit non-authoritative
shadow output, but it may not write production state. A second writer,
permanent dual write, cross-machine mutable file, or implicit compatibility
authority has a hard-zero budget.

A future cutover must change `migrationPhase` through retained parity,
recovery, review, and rollback evidence. Removing the legacy writer is part of
cutover; dual authority is not a migration phase.

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

## 6. Non-claims

This Wave 0 constitution does not migrate Delivery Warrant, Release
Transaction, activation, publication, or any other production writer to Rust.
It does not select a final Rust/libnode ABI, introduce a daemon or service
database, move consumers to v4, or publish v4 as stable.

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
It freezes one closed schema authority and one Rust shadow state-fold authority
for append-only intent, attempt, rooted observation, confirmation, and
reconciliation records. The TypeScript plane performs contract and conformance
projection against the same fixtures; v3 remains the sole production writer.

Logical operation identity excludes attempt ordinals and mutable provider or
runner facts. Every retry preserves `operationRoot`, while every attempt and
observation has a distinct causal entry root. The fold rejects impossible
transitions, non-append sequence, confirmation without successful rooted
observation, conflicting confirmation, reconciliation disagreement, and
authority-root escalation. Provider SDK imports, live mutations, production
write-authority changes, and v3 behavior changes retain hard-zero budgets.
