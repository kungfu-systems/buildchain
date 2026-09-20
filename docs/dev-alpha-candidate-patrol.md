---
status: preview
period: ongoing
theme: dev-alpha-candidate-patrol
doc_type: architecture-and-usage
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
  visible_context: Buildchain v4 parity of the proven v3 Release Train and Release Cut contracts, existing source locks, exact-source Alpha preflight, Dev Patrol, cancelled duplicate runs, protected auto-merge policy, repository release governance, and the consumer-owned settlement renderer threat model.
  invisible_context_boundary: No credentials, private logs, or private configuration were used.
---

# Dev to Alpha Candidate Patrol

This is the internal `.ops-alpha-candidate-patrol.yml` mechanism. Current
consumers use a legal channel PR and the shared normal pipeline; they do not add
a patrol caller, renderer or controller-state inputs. The retained controller
contract below describes implementation and historical qualification.

Buildchain provides a reusable observation and single-flight PR controller for
repositories that promote a development branch into a protected Alpha branch.
It does not publish Alpha. The read-only observer reads the exact heads of both
branches, walks the
bounded development history from newest to oldest (stopping early at the Alpha
head), and selects the newest commit that satisfies all of these conditions:

- the source is strictly ahead of the recorded target head;
- the latest completed, non-cancelled Dev Patrol for that exact commit SHA
  succeeded;
- the latest completed, non-cancelled Alpha preflight for the same commit SHA
  succeeded; and
- both runs are within the caller's evidence age limit.

When no managed candidate is active, the selected commit can be behind the observed development head when newer
commits have not completed both workflows yet. The decision binds the observed
head, selected SHA, and count of skipped newer commits. This makes a slow native
verification lane live under continuous development without silently treating
an unqualified head as releasable.

Before any new selection, the v4 controller now resolves the open managed PR and
validates its embedded authoritative Release Train. If one exists, the frozen
Release Cut wins: Candidate Patrol does not scan for or retain a newer qualified
candidate. It returns the cut's exact candidate commit, candidate tree,
generation, Alpha base, Buildchain runtime and authority roots. A newer dev head
is appended once as a rooted, non-invalidating observation. Repeated webhooks or
a restarted controller observing the same dev head reuse the existing
observation and do not change the candidate identity.

A cancelled workflow run carries no qualification verdict, so a newer
cancelled duplicate does not erase the prior completed verdict for the same
workflow and source SHA. Other non-success conclusions remain authoritative:
a newer failed, timed-out, skipped, or otherwise non-successful completed run
still excludes that SHA and forces the controller to fall back or fail closed.

History discovery is bounded to the newest 1000 development commits. The
controller then compares the selected SHA to the exact Alpha head before it can
be eligible, so a bounded scan cannot turn a commit outside the promotion
ancestry into a candidate.

Generated next-development version preparation is not a product candidate. The
observer skips both the signed `chore(release): prepare ...` commit and its
two-parent integration commit. When later product work becomes qualified, the
nearest preparation becomes a reservation: Patrol reads every path changed by
that preparation at both exact SHAs and requires identical Git blob identities.
A missing or stale reserved path blocks selection before the Release Cut and
therefore before any heavy candidate build.

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
- `held`: the active Release Cut failed exact candidate, tree, Alpha-base,
  runtime or route readback and cannot resume;
- `superseded`: the embedded train contains a valid explicit supersession
  transition;
- `stale`: the available exact-SHA evidence pair is outside policy age; or
- `blocked`: qualification or reconciliation failed closed.

New v4 states embed the complete `kungfu-buildchain-release-train/v1` record.
`held` states include a rooted `kungfu-buildchain-release-train-hold/v1`
receipt with the expected cut and observed coordinates. Dev movement alone is
not an allowed supersession cause. Legacy markers remain readable by the core
contract, but the active-train workflow refuses to manufacture missing Release
Cut authority for an already-open legacy PR.

## Internal workflow

The internal component separates read-only observation from write-permission
settlement. Its source, target, rooted observations and optional internal renderer
remain implementation ports. A renderer receives reduced authority, must bind
the exact observed source, and cannot inject managed controller markers. Rendered
bytes must be revalidated before any write; they are not new consumer wiring.

The separately permissioned `settle` job prepares the entry-selected runtime,
re-runs the exact observation, and compare-and-swap
checks the selected SHA, prior controller root and Release Cut root before any
write. With no active managed candidate, it reads the candidate tree and creates
one rooted Release Cut before it creates one branch named from
the target branch and the first 12 characters of the full source SHA. An
existing branch must point to the same full SHA or the run fails. With one
active managed candidate, it validates the candidate ref, tree and Alpha base
before returning that source SHA to every checkout/build consumer. It only
updates the machine-readable state marker when a new dev observation or hold
receipt must be persisted. Repeated events and rapid dev progress cannot create
another candidate PR or another heavy candidate build. Foreign human-authored
Alpha PRs are ignored. More than one open Buildchain-managed candidate fails
closed.

The PR body is the bounded durable controller state: it preserves the active
Release Train without introducing an always-on service. Once the active PR
settles, is explicitly superseded, or is abandoned, the next execution may
recompute current exact-SHA qualification and cut a new generation under the
Release Train contract. It never trusts a `workflow_run` trigger SHA as
evidence.

The workflow exposes `train-root`, `cut-root`, `candidate-generation`,
`candidate-tree-sha`, `runtime-sha`, `drift-root` and `hold-root` alongside the
selected SHA. Alpha build orchestration should bind to those outputs and treat
a non-empty hold root as a fail-closed result.

An authorized internal invocation may set `auto-merge: true` and choose `merge-method`
from `merge`, `squash`, or `rebase`. Buildchain only arms GitHub auto-merge for
the single managed, open, exact-source candidate after the write-permission
settlement has revalidated the observation. GitHub still owns every required
review, required check, branch-protection, and merge-queue gate; Buildchain does
not approve or directly merge the PR. Invalid merge methods and GraphQL
refusals fail the patrol run.

Runtime-owned routing and server-side reconciliation handle duplicate and delayed
events. Consumers do not configure completion listeners or fallback cron jobs.

The workflow never moves the Alpha ref directly, directly merges the pull
request, approves it, publishes npm, creates a Git tag or GitHub Release, or
changes branch protection. Optional auto-merge only registers repository-owned
intent with GitHub; protected settlement remains authoritative.
