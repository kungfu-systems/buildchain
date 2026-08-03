---
status: preview
period: ongoing
theme: dev-qualification-patrol
doc_type: architecture-and-usage
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-03
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-03
  visible_context: Existing Buildchain Shifu Gate receipts, Kungfu Dev Patrol, Alpha preflight, candidate patrol, and GitHub failed-job rerun semantics.
  invisible_context_boundary: No credentials, private logs, or private configuration were used.
---

# Dev Qualification Patrol

Buildchain provides a reusable controller for repositories whose development
branch advances faster than a heavy cross-platform qualification workflow can
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

Call `.github/workflows/dev-qualification-patrol.yml` from a thin consumer
workflow after the lightweight preflight, Dev Patrol, and declared priority
workflows complete. Add an offset schedule as recovery for delayed or missed
GitHub events. Repeated wakeups are idempotent.

The controller requires a successful preflight whose `head_sha` equals the
current source head. It dispatches the heavy workflow on the source branch and
adds a controller-owned `source-sha` input. The consumer must reject the run
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

Start a consumer in dry-run mode. Its observation and mutation decisions are
retained as exact-source artifacts with a canonical decision root. Enabling
mutation requires a repository token that can write Actions; no contents,
pull-request, tag, release, package, or publication permission is used.

The controller does not merge a PR, publish an Alpha, create a tag, create a
release, or settle a Release Passport. Once Dev and Alpha preflight evidence
both succeed for one SHA, the separate
[Dev to Alpha Candidate Patrol](dev-alpha-candidate-patrol.md) may select it.
