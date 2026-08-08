---
status: draft
period: ongoing
theme: dev-delivery-warrant
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-05
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-04
  invisible_context: not asserted
---

# Dev Delivery Warrant Queue

Buildchain's Dev Delivery Warrant Queue gives a qualified slow pull request a
durable, non-preemptive delivery turn without replacing GitHub Merge Queue as
the final protected-ref authority.

The queue is stored on a dedicated Git ref below
`buildchain/dev-delivery-warrant/`. Every update creates a child Git commit and
advances the ref without force. The transition receipt binds the expected old
state root; a competing controller receives a visible non-fast-forward failure
instead of a second authority claim.

## Contract

A submission binds the repository, protected dev line, pull request, semantic
source identity, exact source head, native Assignment and Initiative roots,
source patch or tree intent, reusable Source Qualification Proof, plan,
affected closure, dependencies, toolchain, delivery class, priority, attempts,
and retained enqueue time.

Selection is deterministic FIFO plus aging with bounded priority. Priority may
reorder queued work, but it cannot preempt the active Warrant. Exactly one
candidate receives a leased Warrant containing a fencing token, lease
generation, expected-old state root, expiry, and the complete exact source
binding. Heartbeat extends only that generation. Expiry recovery rejects the
old token, retains queue age, and returns the candidate to selection.

A terminal event may cancel a candidate before selection without minting a
Warrant. This transition is limited to an exact non-active queued candidate and
binds its candidate root, pull request, recorded source head, event-observed
source head, terminal event action, evidence root, and expected-old queue root.
An active candidate still requires its current fencing token and lease
generation. Exact duplicate cancellation evidence is a visible no-op; identity,
state, event, or evidence drift fails closed.

The reusable terminal controller uses one `settle` operation for active,
queued, already-terminal, and never-admitted pull requests. An active Warrant
still requires its exact fence and evidence. A matching queued cancellation is
persisted normally. A duplicate terminal event or a pull request that never
entered Warrant authority returns a rooted explicit no-op instead of failing
the workflow or inventing queue state.

The supported priority classes are `ordinary`, `expedited`, and `emergency`.
The queue does not infer an emergency: callers must choose it explicitly under
their reviewed policy. Delivery classes are `non-native-fast`,
`native-proof-required`, `cross-platform`, and `release`.

## Split proof authority

Source Qualification Proof is independent of the moving dev base. It binds the
semantic source, exact source head and patch/tree intent, plan, affected
closure, dependencies, toolchain, covered paths, and shard evidence.

Before reuse, the consumer classifies the dev delta:

- unchanged roots plus an unrelated attributed delta reuse source
  qualification and run only a cheap Project Cut replay. GitHub's `behind`
  state is accepted only when a rooted replay proof binds the exact current
  protected base, unchanged PR head and source patch, replay tree, required
  context roots, and a qualified `project.cut.merge-queue-admission/v1`
  receipt;
- an overlapping delta reruns the affected source shards;
- an unknown graph or changed source, plan, closure, dependency, or toolchain
  root fails closed to full source qualification.

Integration Delivery Proof is separate and cannot be cached across candidates.
It binds the exact current dev base, replay tree, GitHub `merge_group` head and
tree, active Warrant fencing generation, Source Qualification Proof root, and
final required-context roots. GitHub's exact merge-group checks remain the
final integration authority.

## CLI

Queue commands are dry-run by default:

```sh
buildchain dev warrant submit --repository owner/repository \
  --branch dev/v4/v4.0 --pull-request 123 --source-head <sha> \
  --assignment-root <root> --initiative-root <root> \
  --source-identity-root <root> --source-patch-root <root> \
  --source-proof-root <root> --plan-root <root> --closure-root <root> \
  --dependency-root <root> --toolchain-root <root> \
  --delivery-class native-proof-required

buildchain dev warrant select --repository owner/repository \
  --branch dev/v4/v4.0 --execute

buildchain dev warrant cancel-queued --repository owner/repository \
  --branch dev/v4/v4.0 --candidate-id <root> --pull-request 123 \
  --expected-source-head <queued-sha> --observed-source-head <event-sha> \
  --expected-old <queue-root> --event-action closed --outcome cancelled \
  --evidence-root <terminal-event-root> --execute
```

`heartbeat`, `recover`, `close`, `settle`, `cancel-queued`, and `observe` use the same durable authority.
Warrant-scoped mutations require the exact fencing token and lease generation.
`close` also requires a rooted terminal evidence object.

Proof commands create, verify, classify, and compose the two proof layers:

```sh
buildchain dev proof source ...
buildchain dev proof classify --source-proof source-proof.json ...
buildchain dev proof replay ...
buildchain dev proof replay-proof \
  --qualification-receipt project-cut-admission.json ...
buildchain dev proof integration --warrant-result warrant.json ...
```

## Workflow rollout and rollback

The reusable `dev-pr-auto-merge.yml` supports three explicit rollout modes:

- `off` preserves the previous exact-head admission controller;
- `shadow` qualifies the source and emits a read-only queue submission plan;
- `required` persists the submission, selects the Warrant, and refuses GitHub
  enqueue unless the immutable queue commit, state root, active Warrant, and
  selected candidate all pass exact readback validation. Immediately before
  enqueue, the controller also rereads the current protected state ref and
  verifies the active candidate, fencing token, generation, pull request, and
  exact head. A previously valid result is not authority after terminal
  closeout. Re-running qualification for the same selected head may regenerate
  timestamped proof bytes, but it retains the immutable active Warrant and its
  originally selected proof instead of rewriting or rejecting that attempt.
  Each candidate also retains the exact successful source workflow run. If a
  controller discovers that another candidate owns the active Warrant, a
  configured consumer workflow is dispatched immediately for that exact PR,
  head, and source run; the candidate is not left waiting for a patrol cron.

Consumers should deploy `shadow` first, inspect receipts, then change their
protected caller to `required`. Rollback is a reviewed caller change back to
`off`; it does not delete queue history or reinterpret old receipts. The
terminal reusable workflow creates the exact Integration Delivery Proof for a
merged candidate (or accepts explicit evidence for another terminal outcome),
then closes only the current fencing generation. The separate queued
cancellation reusable workflow cannot close an active generation; it advances
the state ref only when the caller's complete terminal binding and expected-old
root still match. A delayed `dequeued` event is ignored when GitHub readback
shows the same exact PR head is already queued again, so an earlier queue event
cannot close a newer active Warrant generation.

Buildchain uses the same contract for its own protected dev line through
`buildchain-dev-delivery.yml`. The manual caller requires the exact PR head and
all native/source proof roots, pins the runtime to the caller commit, selects
`delivery-warrant-mode: required`, and targets GitHub Merge Queue. It does not
offer an `off` switch: rollback is a reviewed change to this caller, not an
operator-time weakening of a specific delivery attempt.

This mechanism schedules protected delivery only. It does not serialize local
development, source-only checks, unrelated channels, release publication, or
runner provisioning. It never grants authority to enable cloud runner
campaigns.
