# Buildchain Migration Inventory

This inventory records the first migration set for the buildchain monorepo.
It is intentionally conservative: Phase 1 records ownership and status without
changing production consumers.

## Core Self-Bootstrap

| Repository | Current branch | Latest observed stable refs | Phase 1 disposition |
| --- | --- | --- | --- |
| `workflows` | `dev/v2/v2.0` | `v2`, `v2.0`, `v2.0.2-alpha.0` | compatibility surface; migrate reusable workflow sources in Phase 2 |
| `action-bump-version` | `dev/v4/v4.0` | `v4`, `v4.0`, `v4.0.2-alpha.0` | compatibility surface; migrate action implementation in Phase 2 |

## Active Coupled Actions

| Repository | Current branch | Latest observed stable refs | Phase 1 disposition |
| --- | --- | --- | --- |
| `action-publish-prebuilt` | `dev/v2/v2.0` | `v2`, `v2.0`, `v2.0.17-alpha.0` | active; migrate after core self-bootstrap |
| `action-release-note` | `dev/v1/v1.0` | `v1.0-alpha`, `v1.0.2-alpha.48` | active; migrate after core self-bootstrap |
| `action-check-format` | `dev/v1/v1.0` | `v1`, `v1.0`, `v1.0.1-alpha.0` | active; migrate after core self-bootstrap |
| `action-approve` | `dev/v1/v1.0` | `v1`, `v1.0`, `v1.0.1-alpha.0` | active; migrate after core self-bootstrap |
| `action-qa-automated` | `dev/v1/v1.0` | `v1.0-alpha`, `v1.0.0-alpha.11` | active; migrate after core self-bootstrap |
| `action-merge-close-issue` | `dev/v1/v1.0` | `v1.0-alpha`, `v1.0.3-alpha.9` | active; migrate after core self-bootstrap |
| `action-rollback-release` | `dev/v1/v1.0` | `v1`, `v1.0`, `v1.0.1-alpha.0` | active; migrate after core self-bootstrap |

## Deferred Or Unknown

These repositories remain outside the first active migration set until a live
workflow dependency proves they are still needed:

- `action-batch-pull-request`
- `action-find-dependencies`
- `action-generate-download-page`
- `action-generate-release-page`
- `action-package-dependency`
- `action-purge-artifacts`
- `action-set-collaborators`
- `action-sync-airtable`
- `action-sync-extensions-version`
- `action-sync-pr`
- `action-update-dependencies-version`

## Phase 2 Entry Criteria

- This repository has baseline CI.
- Inventory checks pass locally.
- No publishing path is enabled by default.
- Existing `workflows@v2` and `action-bump-version@v4` remain available.

