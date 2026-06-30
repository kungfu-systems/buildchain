# Buildchain v2 Migration Inventory

This inventory records the buildchain v2 migration set. Buildchain v2 is the
monorepo source of truth for active Kungfu reusable workflows and GitHub Actions.
Standalone `workflows` and `action-*` repositories remain compatibility and
rollback anchors while consumers migrate to stable buildchain refs.

## Workflow Sources

| Source repository | Previous branch | Buildchain v2 disposition |
| --- | --- | --- |
| `workflows` | `dev/v2/v2.0` | root `.github/workflows` sources migrated; reusable workflows linted by actionlint |

## Migrated Actions

Migrated actions use `runs.using: node24`, build with tsup, and commit a
generated `dist/index.js` bundle for direct GitHub Actions consumption.

| Buildchain path | Previous repository |
| --- | --- |
| `actions/approve` | `action-approve` |
| `actions/batch-pull-request` | `action-batch-pull-request` |
| `actions/bump-version` | `action-bump-version` |
| `actions/check-format` | `action-check-format` |
| `actions/generate-download-page` | `action-generate-download-page` |
| `actions/generate-release-page` | `action-generate-release-page` |
| `actions/merge-close-issue` | `action-merge-close-issue` |
| `actions/publish-prebuilt` | `action-publish-prebuilt` |
| `actions/qa-automated` | `action-qa-automated` |
| `actions/rollback-release` | `action-rollback-release` |
| `actions/sync-pr` | `action-sync-pr` |
| `actions/update-dependencies-version` | `action-update-dependencies-version` |

## Retired Actions Excluded From v2

These legacy action repositories are intentionally not shipped as buildchain v2
actions because the corresponding workflows now reject the retired mechanism or
because the action is part of that retired path.

| Previous repository | Reason |
| --- | --- |
| `action-find-dependencies` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-package-dependency` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-purge-artifacts` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-release-note` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-set-collaborators` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-sync-airtable` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |
| `action-sync-extensions-version` | retired in workflows v2 or backed by retired Airtable/dependency/collaborator/purge mechanism |

## Buildchain-Native Actions

These actions are new Buildchain v2 surfaces rather than migrations from an
older standalone action repository.

| Buildchain path | Purpose |
| --- | --- |
| `actions/promote-buildchain-ref` | governance-closed Buildchain release ref promotion |
| `actions/validate-config` | `buildchain.toml` version-state and lifecycle preflight without executing lifecycle commands |

## Stable v2 Refs

- Actions: `kungfu-systems/buildchain/actions/<name>@v2`
- Reusable workflows: `kungfu-systems/buildchain/.github/workflows/<workflow>.yml@v2`

## Verification Gates

- `pnpm install --frozen-lockfile`
- `pnpm run check`
- GitHub-hosted `Verify` workflow
- Manual `Self-hosted Runner Smoke` workflow for trusted self-hosted runner validation
