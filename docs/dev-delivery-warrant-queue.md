---
status: preview
period: ongoing
theme: dev-delivery-warrant-queue
doc_type: architecture-and-usage
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-04
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-04
  visible_context: Buildchain Dev PR admission, native merge queue, Dev qualification patrol, and exact-source receipt contracts.
  invisible_context_boundary: No credentials, private logs, private configuration, or hidden provider state were read.
---

# Dev Delivery Warrant Queue

Buildchain's Dev Delivery Warrant Queue is the scheduling authority for slow
protected-development delivery attempts. It sits before GitHub Merge Queue:
Buildchain selects exactly one durable candidate and fences its complete
delivery attempt; GitHub remains the authority for the final `merge_group`
candidate and protected-ref update.

The queue addresses a different problem from
[Dev Qualification Patrol](dev-qualification-patrol.md). Patrol deliberately
coalesces rapid branch heads and retains only the latest pending qualification.
The Warrant Queue retains every explicit protected-delivery intent so an older
40-minute candidate cannot be displaced forever by later fast candidates.

## Versioned state and submission identity

The `kungfu-buildchain-dev-delivery-warrant-queue/v1` state binds:

- repository and exact protected Dev channel;
- immutable policy version, aging quantum, Warrant TTL, priority classes, and
  the non-preemption rule;
- monotonically increasing submission sequence and fencing generation;
- the single active Warrant, all queued and terminal candidates, transition
  history, and delivery-waste metrics; and
- a canonical `sha256` revision over the complete state except the revision
  field itself.

Each submission identity binds repository, protected base, pull request, exact
source head, semantic source root, the verified Source Qualification Proof
root, Assignment root, Initiative root, and delivery class. Repeating the exact
identity is a byte-stable no-op. A repair may retain the original enqueue time
only when the semantic source root is unchanged and a new exact Source Proof is
supplied; changed source is a new submission. A base-only advance is not a
repair and never rewrites or rotates the physical PR head.

## Split delivery proofs

Protected delivery uses two different proof identities. They are deliberately
not interchangeable:

- `kungfu-buildchain-source-qualification-proof/v1` binds immutable source
  intent, the exact source head and semantic root, qualification plan, affected
  shard closure, dependency graph, toolchain, required successful source
  contexts at that exact head, and evidence roots. The Warrant Queue verifies
  this proof before accepting the submission and includes its root in the
  submission identity.
- `kungfu-buildchain-integration-delivery-proof/v1` binds the exact current
  integration tree, protected-base head, Source Proof, replay receipt, delta
  classification, active Warrant id, fencing token and generation, unexpired
  lease, queue revision, provider receipt, and every successful required
  context at that same tree.

The `kungfu-buildchain-dev-delta-classification/v1` classifier compares the
proof's dependency and toolchain roots with the current candidate and assigns
every changed path to an affected shard or an explicitly unrelated prefix.
Its outcomes are:

- `reuse-source-proof` for no delta or explicit unrelated base-only movement;
- `rerun-affected` for one or more known overlapping shards; and
- `rerun-all` when attribution is unknown or dependency/toolchain roots
  changed.

Unknown paths never count as unrelated. Reusable Source Proof never suppresses
the exact Integration Proof or its current `merge_group` contexts.

The proof CLI reads one operation input JSON and emits a content-addressed
operation receipt:

```sh
buildchain dev proof \
  --operation source-create \
  --input .buildchain/dev-delivery-warrant/source-proof-input.json \
  --output .buildchain/dev-delivery-warrant/source-proof-result.json

buildchain dev proof \
  --operation delta-classify \
  --input .buildchain/dev-delivery-warrant/delta-input.json

buildchain dev proof \
  --operation integration-verify \
  --input .buildchain/dev-delivery-warrant/integration-proof-readback.json
```

The other operations are `source-verify`, `delta-verify`, `replay-plan`,
`replay-receipt-create`, `replay-receipt-verify`, and `integration-create`.
Creation and verification use the same canonical roots.

## Fair selection

The `fifo-aging-v1` policy has three bounded priority classes: `ordinary`,
`urgent`, and `emergency`. Effective priority is the declared class plus one
level per aging quantum, capped at the maximum class. Ties use retained enqueue
time, submission sequence, then submission identity.

This yields two useful guarantees:

1. later candidates in the same class never overtake an older candidate; and
2. a low-priority candidate reaches the maximum effective class after a
   bounded number of aging quanta, then wins ties by its older retained age.

Priority may change only while queued. `emergency` additionally requires a
content-addressed reviewed-policy root and a `security` or `emergency` reason.
Once selected, a candidate is non-preemptive. A different emergency behavior
requires a reviewed successor policy rather than an ad-hoc controller flag.

## Warrant and fencing

Selection issues one `Delivery Warrant` containing the submission identity,
controller identity, issuance and expiry times, monotonically increasing
generation, Warrant root, and fencing token. Every heartbeat or lifecycle
transition requires all of:

- the exact expected-old queue revision;
- the current Warrant root;
- the current fencing token; and
- an unexpired lease.

The selected Warrant owns replay, proof recording, waiting, GitHub Merge Queue
enqueue, merge observation, and terminal closeout. The lifecycle is
intentionally constrained:

```text
queued
  -> warrant-issued
  -> replaying
  -> record-replay (Source Proof + delta classification + candidate tree)
  -> proving
  -> enqueue-github
  -> merge-queued
  -> record-integration-proof (exact merge_group tree + contexts)
  -> observe-merged (exact protected-head readback)
  -> merged
```

`blocked`, `dequeued`, `failed`, and `stale` are visible terminal outcomes.
The state machine refuses GitHub enqueue without a recorded source replay,
persists enqueue rejection as a terminal failure, and refuses `merged` without
an Integration Proof whose tree equals the provider's protected-head readback.
A local controller therefore cannot forge the final GitHub integration
boundary. If a controller crashes after GitHub accepted enqueue but before the
state-ref CAS, its successor adopts only an existing queue entry for the exact
PR and source head; it does not enqueue a duplicate.

After lease expiry, recovery requeues the same candidate with its original
queue age. The next selection increments the fencing generation and changes
the token. A delayed callback from the crashed controller therefore fails even
if it still has the old Warrant bytes.

## Durable provider and two-level compare-and-set

The provider adapter stores canonical state JSON on a dedicated repository ref
under `buildchain-state/dev-delivery/*`, at
`.buildchain/state/dev-delivery-warrant-queue.json`. The state ref is outside
the protected product branch and contains scheduling evidence only.

Every mutation is fenced twice:

1. the command's `expectedOldRevision` must equal the queue revision; and
2. the GitHub Contents write supplies the exact previously read blob SHA.

GitHub accepts at most one write for that blob. A competing controller receives
`STALE_PROVIDER_STATE`, reloads current state, and recomputes; it does not
retry the stale mutation or report success. Transition and persistence
receipts bind the old/new queue revisions, provider blob SHAs, state commit,
controller, action, timestamp, and exact affected submission or Warrant.

The dedicated ref must be created by reviewed repository bootstrap before
enforcement and must grant the controller only the contents permission needed
for that ref. The provider does not store tokens or credentials in state,
receipts, logs, or commits.

Bootstrap is explicit and expected-base fenced:

```sh
buildchain dev warrant \
  --repository kungfu-systems/example \
  --state-ref buildchain-state/dev-delivery/dev-v3-v3.0 \
  --init \
  --branch dev/v3/v3.0 \
  --expected-base 0123456789abcdef0123456789abcdef01234567 \
  --gh-cli
```

Mutation commands are JSON objects containing `action`, `controllerId`, `now`,
and `expectedOldRevision`, plus action-specific candidate or Warrant fields.
Apply one with `--command command.json`; use `--view` for a read-only current
projection. The CLI writes the complete result to
`.buildchain/dev-delivery-warrant/result.json` unless `--output` is set.

## Observable states and rollback

The queue view exposes `submitted`/`queued`, `warrant-issued`, `replaying`,
`proving`, `waiting`, `merge-queued`, `blocked`, `stale`, `dequeued`, `failed`,
`merged`, and recovered state through each candidate's state and reason. It
also exposes retained age, queue position, next action, active Warrant,
base-only head rotations, explicit source-head repairs, repeated heavy
validations, recoveries, impermissible overtakes, and wasted runner seconds. It
also exposes the Source Proof, delta
classification, replay receipt, Integration Proof, candidate tree, integration
tree, and exact merged-head roots recorded for each candidate.

Initial rollout is shadow-only: compute and publish queue views without using
them to suppress the existing position-one controller. Enforcement begins only
after protected fault and starvation qualification. Rollback stops new Warrant
selection and returns admission to the existing position-one controller; it
does not delete the state ref, receipts, history, or an already selected
attempt. The selected attempt must reach an explicit terminal state before the
fallback controller can own another delivery.

## Qualification boundary

The deterministic suite covers FIFO, aging, 100 later ordinary arrivals,
bounded priority, emergency-policy evidence, duplicate submit, expected-old
races, provider CAS races, heartbeat, expiry, crash recovery, stale callbacks,
same-source repair, non-preemption, lifecycle enforcement, split-proof roots,
unrelated/overlapping/unknown delta classification, failed required contexts,
and visible next actions. A deterministic 40-minute campaign injects eligible
fast arrivals every five minutes and requires bounded progress, zero
impermissible overtakes, no base-only PR-head rotation, and no repeated heavy
validation for unrelated movement. Protected prospective qualification must
still run the same shape against GitHub and retain exact merge-group readback as
integration evidence.
