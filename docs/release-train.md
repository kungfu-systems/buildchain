---
status: preview
period: ongoing
theme: buildchain-release-train
doc_type: architecture-and-usage
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-10
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-10
  visible_context: Buildchain v3 release candidate, recovery, Dev to Alpha Candidate Patrol, Warrant, publication transaction, and release governance sources.
  invisible_context_boundary: Live provider state and credentials were not read.
---

# Release Train and Release Cut

Buildchain v3 exposes a pure, provider-neutral Release Train contract for
retaining one authorized Alpha candidate while the development branch keeps
moving. The contract does not select a candidate, write a Git ref, open a pull
request, publish a package, or replace any existing provider gate. Controllers
own those effects and persist the rooted contract in their declared store.

## Frozen Release Cut

`createReleaseCut()` records one exact candidate generation. It binds:

- repository, source branch, and target branch;
- the development head from which the cut was authorized;
- candidate commit and tree;
- exact Alpha base and Buildchain runtime commits;
- a positive generation;
- sorted, duplicate-free authority roots; and
- a canonical creation timestamp.

The resulting `cutRoot` covers all of those fields. A generation greater than
one must name the prior cut root and one of four supersession causes:

- `incompatible-semantics`;
- `alpha-base-incompatibility`;
- `invalid-authority`; or
- `severe-security`.

Latest-development movement is deliberately absent from that list. Merely
observing a newer development head therefore cannot replace the candidate or
increment its generation.

## Release Train state

`createReleaseTrain()` wraps the frozen cut in
`kungfu-buildchain-release-train/v1`. The train identity root covers only the
immutable Release Cut. Its state chain can move through:

```text
preparing -> building -> publication-blocked -> publishable -> terminal
                   \-> repair-required --------^          \-> superseded
```

The complete transition table is enforced by the Node API. `superseded` and
`terminal` are terminal states. A superseded transition must bind its explicit
cause, replacement cut root, and replacement candidate commit.

Every transition uses compare-and-swap against the exact current `stateRoot`,
binds non-empty authority roots, and produces deterministic request,
transition, and next-state roots. Replaying the exact same request after it has
already landed returns the existing train unchanged. A stale expected state or
an invalid transition fails closed.

`observeReleaseTrain()` appends a rooted development-head observation without
changing `trainRoot`, `cutRoot`, candidate identity, generation, or state. The
same exact observation is idempotent.

Buildchain v3 Candidate Patrol resolves the open managed candidate's persisted
train before it considers a new qualified development head. It reads back the
candidate ref and tree, Alpha base, and exact Buildchain runtime. Matching
coordinates resume the frozen candidate; a newer development head becomes a
single rooted observation. Candidate, tree, base, runtime, or route drift emits
a rooted hold and stops settlement. Only a validated train already carrying an
enumerated `superseded` transition is reported as superseded.

## Readback and legacy state

`validateReleaseCut()` checks the standalone immutable cut and its canonical
root. `validateReleaseTrain()` replays the complete transition and observation
chain from that frozen cut and rejects root drift, stale compare-and-swap
edges, duplicate observations, or an invalid lifecycle path.

`readReleaseTrain()` also recognizes the existing
`kungfu-buildchain-dev-alpha-candidate-state/v1` patrol marker. That path is a
read-only compatibility projection with `authoritative: false` and `train:
null`. It exposes the legacy generation and candidate SHA when present, but it
never invents a Release Cut, authority root, runtime binding, Alpha base, or
candidate tree retroactively. A controller must create a new, fully witnessed
Release Cut before it can claim Release Train authority.

## Public API and schemas

Import the contract from `@kungfu-tech/buildchain/release-train`. Machine
schemas are published with the package:

- `contracts/release-cut-v1.schema.json`;
- `contracts/release-train-v1.schema.json`; and
- `contracts/release-train-transition-v1.schema.json`.

The schemas check structure. The Node validator remains authoritative for
canonical roots, state-chain replay, idempotence, and cross-field semantics.
