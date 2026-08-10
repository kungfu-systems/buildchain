---
status: preview
period: ongoing
theme: engineering-housekeeper
doc_type: operational-contract
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: reviewed
last_reviewed: 2026-08-10
---

# Engineering Housekeeper

Engineering Housekeeper is a reusable GitHub workflow for evidence-backed
branch and pull-request hygiene. It inventories the complete GitHub branch and
open pull-request surfaces, produces a rooted plan, and defaults to report-only
execution. It never closes pull requests and never deletes a branch from its
name alone.

The reusable entrypoint is:

```yaml
uses: kungfu-systems/buildchain/.github/workflows/engineering-housekeeper.yml@v3
```

## Report mode

`report` is the default. The caller grants only read permissions and receives
separate plan, Markdown report, and dry-run receipt artifacts:

```yaml
jobs:
  housekeeper:
    uses: kungfu-systems/buildchain/.github/workflows/engineering-housekeeper.yml@v3
    permissions:
      contents: read
      pull-requests: read
    with:
      target-branch: dev/v3/v3.0
      mode: report
```

The plan records the exact repository, target branch and target OID, every
observed branch and open pull request, each retain/delete/report/label decision,
and stable reason codes. The report receipt records dry-run outcomes and binds
them to the plan root.

## Apply mode

Mutation has a two-part positive gate. The caller must set both `mode: apply`
and `apply-enabled: true`; either value alone fails closed. Apply jobs consume
the uploaded exact plan, re-read provider state, and revalidate exact branch
and target OIDs, ancestry, protection, retention, active pull requests, rename
state, pull-request state, and staleness before each mutation.

```yaml
jobs:
  housekeeper:
    uses: kungfu-systems/buildchain/.github/workflows/engineering-housekeeper.yml@v3
    permissions:
      contents: write
      pull-requests: write
    with:
      target-branch: dev/v3/v3.0
      mode: apply
      apply-enabled: true
      stale-pull-request-label: stale-housekeeping
      max-actions: 10
```

Branch deletion and pull-request labeling run in separate jobs. The branch job
has `contents: write` plus `pull-requests: read` for the final active-PR fence.
The labeling job has `contents: read` and `pull-requests: write`. Inventory is a
separate read-only job. The reusable workflow declares no workflow-level write
permission.

The action limit applies to the globally ordered plan before actions are split
by permission surface. A race, missing branch, advanced head, target movement,
new pull request, new protection, ambiguous ancestry, provider error, or stale
plan/input mismatch is an explicit receipt outcome rather than permission to
continue.

## Inputs and outputs

| Input                      | Type    | Default                     | Contract                                                                          |
| -------------------------- | ------- | --------------------------- | --------------------------------------------------------------------------------- |
| `repository`               | string  | caller repository           | Exact `owner/repo` target.                                                        |
| `target-branch`            | string  | required                    | Exact ancestry target; the observed OID is recorded in the plan.                  |
| `mode`                     | string  | `report`                    | `report` or `apply`. Other values fail.                                           |
| `apply-enabled`            | boolean | `false`                     | Required positive gate for `apply`. Invalid with `report`.                        |
| `protected-patterns`       | string  | version/release families    | Comma or newline separated branch globs.                                          |
| `retained-patterns`        | string  | train/authority families    | Comma or newline separated retention globs.                                       |
| `stale-days`               | number  | `30`                        | Positive stale pull-request age.                                                  |
| `stale-pull-request-label` | string  | empty                       | Empty keeps pull requests report-only; non-empty permits labeling, never closure. |
| `max-actions`              | number  | `20`                        | Positive global apply limit.                                                      |
| `artifact-retention-days`  | number  | `30`                        | Retention for plan, report, and receipts.                                         |
| `buildchain-repository`    | string  | `kungfu-systems/buildchain` | Runtime source repository.                                                        |
| `buildchain-ref`           | string  | `v3`                        | Runtime ref; trusted manual qualification may pass a train or exact SHA.          |

Stable outputs are `plan-root`, `report-receipt-root`, optional
`branch-receipt-root` and `pull-request-receipt-root`, `action-count`,
`outcome`, and the plan/report/default-receipt artifact names. Apply receipts
are uploaded under the same caller-selected artifact prefix with branch and
pull-request scope names.

Artifacts and job summaries contain exact repository coordinates, observed
refs, decisions, reason codes, outcomes, and semantic roots. They never contain
tokens, application private keys, or authorization headers.

## Caller-owned authentication

The default credential is the caller-scoped `github.token`. A caller may pass
an alternative token as `github_token`, or pass the paired `github_app_id` and
`github_app_private_key` secrets to mint an installation token for the exact
target repository. The workflow contains no repository-specific personal
credential name or value.

GitHub App credentials must be supplied as a pair. The caller owns App
installation and permission policy and should grant only repository contents
read/write and pull-request read/write scopes required by its selected mode.
Secrets are used only as step environment or action inputs and are not written
to plans, reports, receipts, summaries, or artifacts.

## Scheduled callers

Buildchain dogfoods the reusable contract through three thin callers:

- `engineering-housekeeper-daily.yml` uses a 30-day window and a 10-action cap;
- `engineering-housekeeper-weekly.yml` uses a 45-day window and a 20-action cap;
- `engineering-housekeeper-monthly.yml` uses a 60-day window and a 50-action cap.

Schedules are report-only and read-only. Apply is available only through a
manual dispatch that selects `apply` and positively enables the apply gate.
The callers contain schedules and policy values only; inventory, planning,
revalidation, mutation, evidence, and authentication stay in the reusable
workflow and its runtime.
