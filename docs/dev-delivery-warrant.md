---
status: accepted
period: ongoing
theme: dev-delivery-warrant
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-11
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-11
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
candidate receives a `provisional` leased Warrant containing a fencing token,
lease generation, expected-old state root, expiry, and the complete exact
source binding. It reserves the next protected-dev landing before expensive
native shards start, but it is not GitHub Merge Queue admission authority.
Heartbeat extends only that generation. Native proof success atomically
upgrades the same token and generation to `qualified`; only then may enqueue
begin. Expiry recovery rejects the old token, retains queue age, and returns
the candidate to selection.

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

A release-blocker candidate may additionally carry a rooted priority claim
created from a settled Release Train dual landing. The claim binds the exact
Assignment, Initiative, repair, prior and successor cuts, candidate generation,
cut candidate, Dev head, semantic patch, both landing evidence roots, and
publication gate. Only a claim whose repository, protected base, Work roots,
head, patch, and claim root match the queued candidate enters the blocker lane.
That lane outranks not-yet-leased ordinary work, but never preempts or rewrites
an active Warrant; unrelated, conflicted, mismatched, or fabricated claims fail
closed before selection.

## Three proof authorities

Source Qualification Proof is created from the cheap source-acceptance gate. It
binds the semantic source, exact source head and patch/tree intent, plan,
affected closure, dependencies, toolchain, covered paths, and exact acceptance
evidence. Ready state and approval are established before provisional
selection.

Native Qualification Proof is separate. It binds semantic source and patch,
plan, affected closure, dependency graph, toolchain, covered paths, native
shard evidence, and the exact dev base used by the native composition. Before
reuse, the consumer classifies the dev delta:

- unchanged semantic roots plus an unrelated fully attributed base delta reuse
  native qualification and run only a cheap Project Cut replay. GitHub's `behind`
  state is accepted only when a rooted replay proof binds the exact current
  protected base, unchanged PR head and source patch, replay tree, required
  context roots, and a qualified `project.cut.merge-queue-admission/v1`
  receipt;
- an overlapping delta reruns affected native shards or the full native plan;
- an unknown graph or changed source, plan, closure, dependency, or toolchain
  root fails closed to full native qualification.

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

buildchain dev proof native --branch dev/v4/v4.0 \
  --qualified-base <sha> --affected-paths-json '["packages/native"]' ...

buildchain dev proof classify-native --source-proof native-proof.json \
  --current-base <sha> --graph-known true --changed-paths-json '[]' ...

buildchain dev warrant qualify --repository owner/repository \
  --branch dev/v4/v4.0 --fencing-token <root> --lease-generation 1 \
  --native-proof native-proof.json \
  --native-reuse-decision native-reuse-decision.json --execute

buildchain dev warrant cancel-queued --repository owner/repository \
  --branch dev/v4/v4.0 --candidate-id <root> --pull-request 123 \
  --expected-source-head <queued-sha> --observed-source-head <event-sha> \
  --expected-old <queue-root> --event-action closed --outcome cancelled \
  --evidence-root <terminal-event-root> --execute
```

`heartbeat`, `qualify`, `recover`, `close`, `settle`, `cancel-queued`, and `observe` use the same durable authority.
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

## Bounded-concurrency shadow qualification

The default production queue remains single-flight. A separate effect-disabled shadow
planner can replay the same deterministic candidate order with a bound of one
or two lanes. It does not issue, renew, supersede, close, or persist a Warrant;
it cannot enqueue a pull request; and its output explicitly carries no
production or rollout authority.

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
only evidence for a separate reviewed rollout decision; it never changes the
live Warrant schema, queue state, merge-queue policy, or protected branch.

## Opt-in bounded qualification and exclusive landing

Buildchain also defines an explicit production opt-in that turns successful
shadow evidence into a separate v2 authority state. It does not widen or
reinterpret the v1 Warrant queue. The accepted
[`Qualification Lease and Landing Warrant ADR`](dev-delivery-qualification-landing-adr.md)
and `contracts/dev-delivery-authority-v2.schema.json` are authoritative.

In `bounded-qualification-landing` mode, a configured number of exact
Qualification Leases may coexist. Each lease carries
`authority = qualification-only` and `mergeGroupAdmission = false`. Completing
qualification records evidence and releases that lease. Qualified candidates
then wait for the one `Landing Warrant`, which alone carries
`authority = merge-group-admission` and may be checked for `merge_group`
admission.

The public command family is explicit:

```sh
buildchain dev authority migrate --repository owner/repository \
  --branch dev/v3/v3.0 --legacy-state v1-queue.json --execute --json
buildchain dev authority lease-qualification --repository owner/repository \
  --branch dev/v4/v4.0 --execute
buildchain dev authority complete-qualification --repository owner/repository \
  --branch dev/v4/v4.0 --candidate-id <root> \
  --authority-token <root> --authority-generation 1 \
  --evidence-root <qualification-root> --execute
buildchain dev authority lease-landing --repository owner/repository \
  --branch dev/v4/v4.0 --execute
buildchain dev authority admit-merge-group --repository owner/repository \
  --branch dev/v4/v4.0 --candidate-id <root> \
  --authority-token <root> --authority-generation 1 \
  --merge-group-head <sha>
```

Terminal settlement releases either authority immediately from exact evidence;
it does not wait for TTL. Exact duplicate settlement is a state-root-preserving
no-op. The default `buildchain dev warrant` commands, v1 state bytes, and
single-flight behavior do not change while this mode is off.

## Workflow rollout and rollback

The reusable `dev-pr-auto-merge.yml` supports three explicit rollout modes:

- `off` preserves the previous exact-head admission controller;
- `shadow` qualifies the source and emits a read-only queue submission plan;
- `required` persists the submission, selects a provisional Warrant, runs or
  reuses semantic native proof under heartbeat, atomically qualifies the same
  fence, and refuses GitHub enqueue unless the immutable queue commit, state root, active Warrant, and
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

The required controller checks the protected base again after native work. A
disjoint attributed delta reuses the proof. Overlap or unknown attribution
triggers one automatic revalidation on the latest base; continued overlap,
native failure, cancellation, semantic head movement, or an unrecoverable merge
conflict closes the exact fence. The next queued candidate is notified through
the `buildchain-dev-delivery-wake` repository event. If cancellation prevents
cleanup, lease expiry recovers retained queue age and mints a new fence.

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
semantic source roots, accepts an optional reusable native proof, pins the runtime to the caller commit, selects
`delivery-warrant-mode: required`, and targets GitHub Merge Queue. It does not
offer an `off` switch: rollback is a reviewed change to this caller, not an
operator-time weakening of a specific delivery attempt.

`buildchain init --type native` generates the corresponding protected-dev
consumer workflow. It supports both explicit dispatch and the bounded wake
event, uses the same reusable controller, and keeps the native command in the
consumer repository rather than inventing provider-specific shards.

This mechanism schedules protected delivery only. It does not serialize local
development, source-only checks, unrelated channels, release publication, or
runner provisioning. It never grants authority to enable cloud runner
campaigns.
