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
last_reviewed: 2026-08-04
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
  qualification and run only a cheap Project Cut replay;
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
```

`heartbeat`, `recover`, `close`, and `observe` use the same durable authority.
Warrant-scoped mutations require the exact fencing token and lease generation.
`close` also requires a rooted terminal evidence object.

Proof commands create, verify, classify, and compose the two proof layers:

```sh
buildchain dev proof source ...
buildchain dev proof classify --source-proof source-proof.json ...
buildchain dev proof replay ...
buildchain dev proof integration --warrant-result warrant.json ...
```

## Workflow rollout and rollback

The reusable `dev-pr-auto-merge.yml` supports three explicit rollout modes:

- `off` preserves the previous exact-head admission controller;
- `shadow` qualifies the source and emits a read-only queue submission plan;
- `required` persists the submission, selects the Warrant, and refuses GitHub
  enqueue unless the exact active Warrant passes readback validation.

Consumers should deploy `shadow` first, inspect receipts, then change their
protected caller to `required`. Rollback is a reviewed caller change back to
`off`; it does not delete queue history or reinterpret old receipts. The
terminal reusable workflow creates the exact Integration Delivery Proof for a
merged candidate (or accepts explicit evidence for another terminal outcome),
then closes only the current fencing generation.

This mechanism schedules protected delivery only. It does not serialize local
development, source-only checks, unrelated channels, release publication, or
runner provisioning. It never grants authority to enable cloud runner
campaigns.
