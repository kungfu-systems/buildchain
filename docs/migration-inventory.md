# Buildchain v2 Migration Inventory

This inventory records the buildchain v2 action surface. Buildchain v2 is the
monorepo source of truth for active Kungfu reusable workflows and the three
GitHub Actions that are still part of Buildchain's reusable contract.
Standalone `workflows` and `action-*` repositories are historical rollback
anchors, not active Buildchain migration targets.

## Workflow Sources

| Source repository | Previous branch | Buildchain v2 disposition |
| --- | --- | --- |
| `workflows` | `dev/v2/v2.0` | root `.github/workflows` sources migrated; reusable workflows linted by actionlint |

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
| `action-bump-version` | replaced by Buildchain release-line scripts and `actions/promote-buildchain-ref` |
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

## Buildchain-Native Actions

These actions are new Buildchain v2 surfaces rather than migrations from an
older standalone action repository.

| Buildchain path | Purpose |
| --- | --- |
| `actions/promote-buildchain-ref` | governance-closed Buildchain release ref promotion |
| `actions/run-lifecycle` | lifecycle command execution and deterministic artifact manifest generation |
| `actions/validate-config` | `buildchain.toml` version-state and lifecycle preflight without executing lifecycle commands |

## Stable v2 Refs

- Actions: `kungfu-systems/buildchain/actions/<name>@v2`
- Reusable workflows: `kungfu-systems/buildchain/.github/workflows/<workflow>.yml@v2`

## Verification Gates

- `pnpm install --frozen-lockfile`
- `pnpm run check`
- GitHub-hosted `Verify` workflow
- Manual `Self-hosted Runner Smoke` workflow for trusted self-hosted runner validation
