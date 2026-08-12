---
status: local-model-ready-hosted-evidence-pending
period: 2026-08-12
theme: parallel-qualification-self-dogfood
doc_type: qualification-continuation
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: C
review_state: unreviewed
---

# Parallel qualification self-dogfood continuation

This record tracks the Buildchain-only work required by Assignment
`2026-08-12-buildchain-parallel-qualification-self-dogfood`. It is not a Work
completion record and does not replace independent assessment.

## Implemented local cut

- `packages/core/dev-delivery-qualification-lanes.js` defines a bounded-two-lane
  production qualification state, exact-old compare-and-swap transitions,
  lease fencing, proof reuse, one scalar Landing Warrant, terminal settlement,
  and fail-closed validation.
- `scripts/dev-delivery-parallel-dogfood.mjs` deterministically exercises slow
  and fast disjoint progress, overlap and unknown-delta rejection,
  cancellation, heartbeat, lease expiry, retry, Dev advance, and terminal
  Warrant retention. Its convergence record retains rooted receipts for
  heartbeat failure, runner loss, lane and Warrant expiry, exact-head change,
  Dev advance, duplicate-controller fencing, cancellation, and retry.
- `buildchain-dev-delivery.yml` invokes the checked-in reusable workflow through
  `kungfu-systems/buildchain/.github/workflows/dev-pr-auto-merge.yml@dev/v3/v3.0`
  and retains the model report after the delivery job.
- The hosted model report deliberately leaves protected Dev readback,
  `merge_group`, child Assignment, review, and pilot-decision evidence empty.

This cut is not active production authority. The reusable delivery workflow
still uses the prior single-flight Warrant path until the five child changes,
hosted comparison, reviewed live switch, and rollback evidence exist.

## Five child delivery records

The final hosted record requires five independent child rows. Each row must
contain the child Assignment ID and root, PR number and exact head, successful
Buildchain qualification run ID and attempt, terminal sealed native state and
root supplied by that child, protected Dev merge SHA, exact ancestry readback,
artifact ID, artifact digest, and reviewer disposition.

The intended independently reviewable slices are:

1. qualification state and two-lane scheduler;
2. heartbeat, loss, expiry, retry, cancellation, and proof reuse;
3. exclusive Landing Warrant and terminal settlement;
4. external-syntax reusable workflow and Buildchain-only hosted dogfood;
5. shadow/live comparison, cutover, rollback, merge-group and final review.

No row exists in this local cut. Creating placeholder roots or treating the
single working-tree diff as five children would forge the acceptance evidence.

## Hosted acceptance record

The reviewed hosted record must retain:

- two disjoint PR qualification runs with overlapping time intervals;
- telemetry whose maximum active Qualification Lane count is two and maximum
  active Landing Warrant count is one;
- a slow earlier candidate and later fast disjoint candidate, with the fast
  candidate progressing first and the slow candidate later receiving a
  Warrant;
- an overlapping case and an unknown-delta case, both failed closed;
- rooted receipts for cancellation, runner loss, heartbeat failure, lane
  expiry, Warrant expiry, exact-head change, Dev advance, duplicate controller,
  and retry, including which native/source proofs were reused;
- the exact reusable-workflow owner, repository, path, and ref;
- shadow and live plan roots for the same observations;
- the live-switch ref and rollback ref;
- exact `merge_group` head and tree evidence;
- protected `dev/v3/v3.0` readback and ancestry for every child merge;
- every terminal Warrant settlement and an independent review identity.

## Exact remaining obligation

Create and land the five child PRs on protected Buildchain Dev, run the
Buildchain-only hosted caller against their exact heads, retain and review the
complete hosted record above, then record one continuation decision. The only
permitted decisions are `consumer-pilot-may-open` or
`consumer-pilot-remains-closed`, with reasons and reviewer identity. Until
then, the decision is `not-authorized` and no consumer rollout is claimed.

## Next action

Split the implementation into the five child PRs without changing its rooted
contracts, then use the protected Buildchain delivery caller for each exact
head. After all five terminal records exist, run the hosted load-bearing
scenario and perform independent review before considering a consumer pilot.
