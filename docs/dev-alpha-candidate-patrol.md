---
status: preview
period: ongoing
theme: dev-alpha-candidate-patrol
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
  generated_at: 2026-07-29
  visible_context: Existing Buildchain source locks, Kungfu exact-source Alpha preflight, Dev Patrol, protected auto-merge policy, repository release governance, and the consumer-owned settlement renderer threat model.
  invisible_context_boundary: No credentials, private logs, or private configuration were used.
---

# Dev to Alpha Candidate Patrol

Buildchain provides a reusable observation and single-flight PR controller for
repositories that promote a development branch into a protected Alpha branch.
It does not publish Alpha. The read-only observer reads the exact heads of both
branches, walks the
bounded development history from newest to oldest (stopping early at the Alpha
head), and selects the newest commit that satisfies all of these conditions:

- the source is strictly ahead of the recorded target head;
- the latest completed Dev Patrol for that exact commit SHA succeeded;
- the latest completed Alpha preflight for the same commit SHA succeeded; and
- both runs are within the caller's evidence age limit.

The selected commit can be behind the observed development head when newer
commits have not completed both workflows yet. The decision binds the observed
head, selected SHA, and count of skipped newer commits. This makes a slow native
verification lane live under continuous development without silently treating
an unqualified head as releasable.

History discovery is bounded to the newest 1000 development commits. The
controller then compares the selected SHA to the exact Alpha head before it can
be eligible, so a bounded scan cannot turn a commit outside the promotion
ancestry into a candidate.

The decision is `kungfu-buildchain-channel-candidate-decision/v1`. It records the
source and target branches and SHAs, comparison distance, workflow paths, run
identities and attempts, completion times, URLs, policy, and a canonical decision
root. Missing, stale, failed, duplicate, or source-mismatched evidence fails
closed as an auditable `blocked` or `stale` observation and cannot enter
settlement.

The companion state is
`kungfu-buildchain-dev-alpha-candidate-state/v1`. Its current state is one of:

- `observed`: no exact candidate is currently settleable;
- `eligible-for-settlement`: a qualified candidate exists and no managed Alpha
  candidate PR is active;
- `active`: exactly one managed candidate PR is open;
- `retained-next`: an active PR remains authoritative and the newest different
  qualified SHA is retained as `nextCandidate`;
- `stale`: the available exact-SHA evidence pair is outside policy age; or
- `blocked`: qualification or reconciliation failed closed.

When a newer qualified SHA replaces an earlier `nextCandidate`, the state also
records that earlier SHA as `supersededCandidate`. Every state carries exact
repository, source/target refs and SHAs, workflow-run evidence through the
candidate decision, and canonical decision/state roots.

## Reusable workflow

Call `.github/workflows/dev-alpha-candidate-patrol.yml` from a thin repository
workflow. Start with `dry-run: true`. The reusable workflow always runs an
`observe` job with only Actions/content/pull-request read permissions. Once the
repository has proven that its two workflow names and branch topology produce
exact same-SHA evidence, it may set `settlement-authorized: true` and
`dry-run: false`. The older `create-pull-request` input remains a compatibility
alias for settlement authorization.

Repositories whose promotion policy requires a machine-readable PR declaration
can pass static text through `pull-request-body-prefix`. When the declaration
depends on the exact qualified delta, use `pull-request-body-prefix-renderer`
instead. It names a repository-relative Node.js file in the consumer checkout.
The read-only `observe` job checks out the selected SHA with credentials disabled,
runs the renderer with a reduced environment, and requires it to write UTF-8 text
to `BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX_OUTPUT`. The renderer also receives
the selected SHA plus source and target branch names. It may derive a declaration
from the exact checkout and `origin/<target-branch>` without receiving the
promotion token.

Static and rendered prefixes are mutually exclusive. A renderer failure, path
escape, source-SHA mismatch, empty or oversized result, invalid UTF-8, or managed
controller-marker injection fails before the write-permission job can run. The
rendered bytes are retained with the read-only observation artifact and passed
to `settle` as a job output, so the candidate PR is created with the correct
declaration on its first write. Buildchain preserves that repository-owned text
when later observations update only the managed state marker. Before any write,
`settle` also requires its fresh observation to select the same SHA that produced
the rendered bytes. Concurrent qualification progress therefore fails closed
and is recomputed by the next patrol instead of attaching a declaration to the
wrong candidate.

The separately permissioned `settle` job re-runs the exact observation before
any write. With no active managed candidate, it creates one branch named from
the target branch and the first 12 characters of the full source SHA. An
existing branch must point to the same full SHA or the run fails. With one
active managed candidate, it only updates the machine-readable state marker in
that PR body so repeated events and rapid dev progress cannot create another
candidate PR or another heavy candidate build. Foreign human-authored Alpha PRs
are ignored. More than one open Buildchain-managed candidate fails closed.

The PR body is the bounded durable controller state: it preserves the active
candidate and newest retained `nextCandidate` without introducing an always-on
service. Once the active PR settles or is abandoned, the next execution
recomputes current exact-SHA qualification and creates only the newest still
fresh candidate. It never trusts a `workflow_run` trigger SHA as evidence.

The caller may additionally set `auto-merge: true` and choose `merge-method`
from `merge`, `squash`, or `rebase`. Buildchain only arms GitHub auto-merge for
the single managed, open, exact-source candidate after the write-permission
settlement has revalidated the observation. GitHub still owns every required
review, required check, branch-protection, and merge-queue gate; Buildchain does
not approve or directly merge the PR. Invalid merge methods and GraphQL
refusals fail the patrol run.

Consumers should invoke this workflow after relevant qualification workflow
completion and from an offset periodic fallback. GitHub may delay scheduled
runs, so the event path supplies low latency while the fallback supplies
recovery. Workflow concurrency plus the server-side open-PR reconciliation
makes duplicate or delayed events idempotent.

The workflow never moves the Alpha ref directly, directly merges the pull
request, approves it, publishes npm, creates a Git tag or GitHub Release, or
changes branch protection. Optional auto-merge only registers repository-owned
intent with GitHub; protected settlement remains authoritative.
