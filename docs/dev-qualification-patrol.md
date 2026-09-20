---
status: active
period: ongoing
theme: dev-qualification-patrol
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-09-20
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-20
  visible_context: Current workflow taxonomy, shared consumer entry contract, and retained internal qualification controller.
  invisible_context_boundary: No new hosted qualification or external consumer migration is claimed.
---

# Internal Dev Qualification Patrol

This document describes the internal
[`.ops-dev-qualification-patrol.yml`](../.github/workflows/.ops-dev-qualification-patrol.yml)
component. Consumers use the generated normal and attempt recovery callers;
they do not add a patrol workflow, schedule, dispatch payload, or controller
script. See the [Golden Path](getting-started.md).

The retained controller handles internal qualification for a development
branch that advances faster than a heavy cross-platform qualification workflow can
settle. The controller keeps no external queue. On every wakeup it derives the
only pending item from the current source-branch head and maintains these
states:

- `qualified`: the current source SHA already has a successful Dev run;
- `running`: one Dev run is active, with a different current SHA retained as
  the implicit latest pending item;
- `waiting-preflight`: the current SHA has not passed its lightweight exact-SHA
  preflight;
- `waiting-priority`: a declared Alpha or release workflow is queued or active;
- `dispatch-ready`: the latest SHA is preflight-qualified and no Dev or
  priority run is active;
- `retry-ready`: the latest exact-SHA Dev run failed only at a classified
  external boundary and remains inside the attempt limit; or
- `blocked`: the failure was deterministic, unknown, or exhausted its bounded
  retry policy.

This is an event-driven, coalescing controller rather than a FIFO build queue.
If ten commits arrive during one slow Dev run, the next reconciliation observes
only the newest branch head. Intermediate unqualified SHAs are superseded
without consuming the shared native runners.

## Exact-source and priority contract

Internal orchestration owns wakeups from preflight, qualification and priority
workflow completion. Repeated wakeups are idempotent. Event recovery belongs
to the runtime; this component does not require an extra consumer caller.

The controller requires a successful preflight whose `head_sha` equals the
current source head. It dispatches the heavy workflow on the source branch and
adds a controller-owned `source-sha` input. The internal qualification adapter must reject the run
before qualification if that input differs from the workflow event SHA. This
closes the race where the branch advances between observation and workflow
startup. The heavy reusable Gate workflow then receives the exact SHA as its
`source-ref`, so every platform receipt remains source-bound.

`priority-workflows-json` is a JSON array of workflow paths. Any queued,
waiting, pending, requested, or in-progress run in those workflows prevents a
new Dev dispatch or automatic retry. This lets Alpha and release work keep
priority on shared self-hosted runners. A successful current Dev result remains
qualified even when priority work is active; priority only governs new heavy
work.

## Bounded local retry

The controller uses GitHub's failed-jobs rerun endpoint, not a fresh workflow
dispatch, for classified transient failures. Successful matrix jobs and their
exact-source receipts remain in the same workflow-run transaction. Failed jobs
and dependent aggregation run again. The Shifu Gate profile uploads platform,
diagnostic, aggregate, and controller artifacts with overwrite enabled so a
later attempt can replace only the same-run artifact names.

Automatic retry is deliberately narrow:

- whole-run `cancelled`, `timed_out`, or `startup_failure` conclusions qualify;
- checkout, setup, toolchain, download, upload, environment exposure, and
  runner-workspace reset steps qualify;
- Gate execution, Gate enforcement, aggregation, and controller-receipt
  failures never qualify; and
- an unknown failing step fails closed.

`max-attempts` counts the original attempt. The default `2` therefore permits
at most one automatic failed-jobs rerun. This policy reduces retry friction for
network, runner, and provider failures without laundering a product or Gate
failure into an infrastructure retry.

## Permission and mutation boundary

The reusable workflow always performs `observe` with Actions and contents read
permissions. The separate `mutate` job runs only when the observation proposes
`dispatch` or `rerun-failed-jobs`, `mutation-authorized` is true, and `dry-run`
is false. Before writing, it re-resolves the branch and all workflow state and
requires the action and source SHA to match the read-only observation. A race
fails closed and the next event recomputes from current truth.

The internal dry-run mode retains observation and mutation decisions as
exact-source artifacts with a canonical decision root. Its separately scoped
mutation credential can write Actions; it does not receive contents,
pull-request, tag, release, package, or publication authority.

The controller does not merge a PR, publish an Alpha, create a tag, create a
release, or settle a Release Passport. Once Dev and Alpha preflight evidence
both succeed for one SHA, the separate
[Dev to Alpha Candidate Patrol](dev-alpha-candidate-patrol.md) may select it.
