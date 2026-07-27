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
last_reviewed: 2026-07-26
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-26
  visible_context: Existing Buildchain stable-candidate source locks, Kungfu exact-source Alpha preflight, Dev Patrol, and repository release governance.
  invisible_context_boundary: No credentials, private logs, or private configuration were used.
---

# Dev to Alpha Candidate Patrol

Buildchain provides a reusable observation and PR controller for repositories
that promote a development branch into a protected Alpha branch. It does not
publish Alpha. The controller reads the exact heads of both branches and accepts
the development head only when:

- the source is strictly ahead of the recorded target head;
- the latest completed Dev Patrol for that exact source SHA succeeded;
- the latest completed Alpha preflight for the same SHA succeeded; and
- both runs are within the caller's evidence age limit.

The decision is `kungfu-buildchain-channel-candidate-decision/v1`. It records the
source and target branches and SHAs, comparison distance, workflow paths, run
identities and attempts, completion times, URLs, policy, and a canonical decision
root. Missing, stale, failed, duplicate, or source-mismatched evidence fails
closed.

## Reusable workflow

Call `.github/workflows/dev-alpha-candidate-patrol.yml` from a thin repository
workflow. Start with `dry-run: true`. Once the repository has proven that its
two workflow names and branch topology produce exact same-SHA evidence, it may
set `create-pull-request: true` and `dry-run: false`.

Candidate mode creates one branch named from the target branch and the first 12
characters of the full source SHA. An existing branch must point to the same
full SHA or the run fails. The controller then creates or reuses one open pull
request from that immutable branch to the protected Alpha branch.

The workflow never moves the Alpha ref directly, merges or auto-merges the pull
request, publishes npm, creates a Git tag or GitHub Release, or changes branch
protection. Those remain repository-owned protected settlement actions.
