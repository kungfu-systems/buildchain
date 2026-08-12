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
last_reviewed: 2026-08-09
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-09
  invisible_context: not asserted
---

# Parallel Dev Qualification and Landing Warrant

Buildchain separates bounded source qualification from protected landing. Up to
two disjoint pull requests may hold fenced Qualification Lanes concurrently,
while one exclusive Landing Warrant remains the only Buildchain authority that
may admit an exact qualified head to GitHub Merge Queue. GitHub remains the
final protected-ref authority.

The prior single-flight Warrant queue remains readable for settlement,
comparison, and rollback evidence. New production qualification state uses
`kungfu-buildchain-dev-delivery-qualification-lanes/v1`; it does not reinterpret
an old Warrant or convert shadow evidence into live authority.

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

## Bounded production qualification model

The proposed production controller has a hard maximum of two Qualification
Lanes. Each lane binds the exact candidate, source head, protected Dev head, lease
generation, fencing token, heartbeat, and expiry. A candidate with an
overlapping or unknown Dev delta fails closed before it can occupy a lane.
Disjoint candidates are selected in retained enqueue order, except that a
candidate conflicting with an active lane waits while a later disjoint
candidate may use the otherwise idle lane. This permits bounded progress but
does not erase the older candidate's age.

Qualification success seals a reusable exact-source proof and releases the
lane. The Landing Warrant selector only considers sealed candidates and stores
the active Warrant in a scalar field. State validation rejects telemetry that
ever reports more than one active Landing Warrant. A later fast candidate may
land while an earlier slow candidate is still qualifying; after the fast
Warrant settles, the earlier candidate remains eligible and cannot be starved.

Cancellation removes only the exact queued or qualifying candidate. Runner
loss, heartbeat failure, and lane expiry return unproved work to the queue with
a new fence. A retry after qualification, or a disjoint Dev advance, reuses the
rooted qualification proof. Exact-head change retains the native proof but
invalidates source qualification. Overlapping or unknown Dev advance fails
closed. Duplicate controllers must bind the exact expected-old state root, so
only one non-fast-forward state transition can be retained.

The provider-neutral controller model is implemented in
`packages/core/dev-delivery-qualification-lanes.js`. The deterministic fault
and progress dogfood is `scripts/dev-delivery-parallel-dogfood.mjs`. Neither is
live production authority until the hosted cutover record is complete and
reviewed.

## Shadow comparison

The effect-disabled shadow planner remains available to replay the former
single-flight candidate order with a bound of one or two lanes. It does not
issue, renew, supersede, close, or persist a Warrant; it cannot enqueue a pull
request; and its output explicitly carries no production or rollout authority.

Each lane binds the exact queue root and generation, protected-base head,
source head, projected-base root, Project Cut, approval, required checks,
status, and lease evidence. An active production candidate must additionally
match its current fencing token and lease generation. A queued shadow lane must
not carry either. Stale evidence, an occupied native queue, cross-lane evidence
aliasing, shared conflict keys, or an incompatible projected base fails closed.
A failure in one lane remains visible without converting or concealing the
other lane's result.

The planner and aggregate qualification command consume immutable JSON files:

```sh
buildchain dev warrant shadow-plan --input observation.json \
  --max-concurrency 2 --output shadow-plan.json

buildchain dev warrant shadow-qualify --input qualification-input.json \
  --output shadow-qualification.json
```

Both commands reject `--execute`. Qualification reports compare explicit
thresholds for sample count, eligible overlap, projected queue-wait benefit,
additional runner cost, ambiguity, and false positives. A `proceed` result is
comparison evidence for a separate reviewed cutover decision; it never changes
the live Warrant schema, queue state, merge-queue policy, or protected branch.

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
`delivery-warrant-mode: required`, and targets GitHub Merge Queue. The caller
invokes the checked-in reusable workflow through
`kungfu-systems/buildchain/.github/workflows/dev-pr-auto-merge.yml@dev/v3/v3.0`;
it does not use a local reusable-workflow shortcut. It does not offer an `off`
switch: rollback is a reviewed change to this caller, not an operator-time
weakening of a specific delivery attempt.

The same `buildchain-dev-delivery.yml` run executes and retains the parallel
controller model after the reusable delivery job. Its hosted model artifact
explicitly leaves protected Dev readback, `merge_group` evidence, five child
Assignment records, review, and the consumer-pilot decision unset. A successful
model run is not hosted acceptance.

Final evidence must bind all five child PR heads and terminal sealed native
roots, overlapping run intervals for at least two disjoint PRs, the maximum
observed Landing Warrant count, slow/fast ordering, fail-closed cases,
failure-recovery receipts, exact protected Dev readback, merge-group head and
tree, shadow-versus-live comparison, cutover and rollback refs, terminal
Warrant settlements, and reviewer identity. Until those hosted facts are
retained and reviewed, `consumerPilotDecision` stays `not-authorized`; no
consumer rollout may be claimed.

This mechanism schedules protected delivery only. It does not serialize local
development, source-only checks, unrelated channels, release publication, or
runner provisioning. It never grants authority to enable cloud runner
campaigns.
