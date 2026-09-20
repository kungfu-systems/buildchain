---
status: historical
period: 2026-07
theme: buildchain-v2-migration-inventory
doc_type: migration-inventory
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
  invisible_context: not asserted
---

# Buildchain v2 Migration Inventory

This inventory records the dated Buildchain v2 consolidation boundary and its
v3 successor. The original dispositions below remain historical. Current
consumers follow the [minimal schema-2 contract](getting-started.md), using only
the shared normal/recovery pair; historical wrappers are not compatibility APIs.
Standalone `workflows` and `action-*` repositories are historical rollback
anchors, not active Buildchain migration targets.

## Workflow Sources

| Source repository | Previous branch | Buildchain v2 disposition |
| --- | --- | --- |
| `workflows` | `dev/v2/v2.0` | root `.github/workflows` sources migrated; reusable workflows linted by actionlint |

## Historical reusable workflow boundaries

The v2/v3 consolidation retired standalone PR orchestration and direct publish
integrations in favor of the then-current reusable build/promotion engines.
Those engines are now internal components. Their original migration history is
retained in Git; a new consumer must not copy hidden build workflows, a custom
`lifecycle.publish` hook or the former public promotion wrapper.

Current public workflow identities are `public-ops-pipeline.yml` and
`public-ops-recover.yml`. Their source of truth is the workflow taxonomy and
generated catalog. Product differences belong in TOML and product source.

## Migrated Actions

No standalone `action-*` repository is shipped as a Buildchain action anymore.
Old product, operations, PR-helper, page-generation, dependency-sync, and
version-bump actions have either been retired or absorbed into Buildchain's
native lifecycle, reusable workflow, and promotion scripts.

## Retired Actions Excluded From v2

These legacy action repositories are intentionally not shipped as buildchain v2
actions because the corresponding workflows now reject the retired mechanism or
because the action is part of that retired path.

| Previous repository | Reason |
| --- | --- |
| `action-approve` | retired GitHub issue/PR helper; use repository-native GitHub automation |
| `action-batch-pull-request` | retired PR orchestration helper; not part of the Buildchain reusable contract |
| `action-bump-version` | replaced by Buildchain release-line scripts and `actions/release/promotion/ref` |
| `action-check-format` | replaced by project-owned `lifecycle.verify` commands |
| `action-find-dependencies` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-generate-download-page` | retired product page generator; model as project-owned lifecycle/deploy work if needed |
| `action-generate-release-page` | retired product page generator; model as project-owned lifecycle/deploy work if needed |
| `action-merge-close-issue` | retired GitHub issue/PR helper; use repository-native GitHub automation |
| `action-package-dependency` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-publish-prebuilt` | retired S3 prebuilt publisher; use lifecycle publish plus publish transaction evidence |
| `action-purge-artifacts` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-qa-automated` | retired external QA trigger; model as project-owned lifecycle or workflow logic |
| `action-release-note` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-rollback-release` | replaced by Buildchain publish transaction recover/finalize/repair semantics |
| `action-set-collaborators` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-sync-airtable` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-sync-extensions-version` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-sync-pr` | retired PR synchronization helper; not part of the Buildchain reusable contract |
| `action-update-dependencies-version` | retired dependency-version helper; use package-manager adapters and lifecycle commands |

## Retired Workflows Excluded From v2

These legacy workflow entrypoints are intentionally not shipped from the root
`.github/workflows` directory.

| Previous workflow | Reason |
| --- | --- |
| `.batch-pull-request.yml` | retired PR orchestration helper; v2.5 dev integration governance will use a new protected-dev PR protocol instead |
| `.release-new-version.yml` | retained as a fail-closed compatibility stub; direct publish model replaced by source-locked release-candidate promotion |
| `.release-elastic-beanstalk.yml` | retained as a fail-closed compatibility stub; deploy side effects must move behind project lifecycle publish and publish-gate source locks |
| `.sam-release.yml` | retained as a fail-closed compatibility stub; deploy side effects must move behind project lifecycle publish and publish-gate source locks |
| `.wheel-release.yml` | retained as a fail-closed compatibility stub; package publish side effects must move behind project lifecycle publish and publish-gate source locks |

## Buildchain-Native Actions

These actions are new Buildchain v2 surfaces rather than migrations from an
older standalone action repository.

| Buildchain path | Purpose |
| --- | --- |
| `actions/release/promotion/ref` | governance-closed Buildchain release ref promotion |
| `actions/build/lifecycle/run` | lifecycle command execution and deterministic artifact manifest generation |
| `actions/build/lifecycle/validate` | `buildchain.toml` version-state and lifecycle preflight without executing lifecycle commands |

## Historical v3 Refs

- Actions: `kungfu-systems/buildchain/actions/<name>@v3`
- Reusable workflows: `kungfu-systems/buildchain/.github/workflows/<workflow>.yml@v3`

## Verification Gates

- `pnpm install --frozen-lockfile`
- `pnpm run check`
- GitHub-hosted `Verify` workflow
- Manual `Self-hosted Runner Smoke` workflow for trusted self-hosted runner validation
