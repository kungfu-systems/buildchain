# Buildchain v2 Migration Inventory

This inventory records the buildchain v2 action surface. Buildchain v2 is the
monorepo source of truth for active Kungfu repository workflows, the active
reusable build workflow, and the three GitHub Actions that are still part of
Buildchain's reusable contract.
Standalone `workflows` and `action-*` repositories are historical rollback
anchors, not active Buildchain migration targets.

## Workflow Sources

| Source repository | Previous branch | Buildchain v2 disposition |
| --- | --- | --- |
| `workflows` | `dev/v2/v2.0` | root `.github/workflows` sources migrated; reusable workflows linted by actionlint |

## Reusable Workflow Boundaries

The active Buildchain-native reusable surface is:

| Workflow | Disposition |
| --- | --- |
| `.github/workflows/.build.yml` | active reusable build contract: runner presets, trusted event gate, publish source lock, lifecycle commands, deterministic artifacts, aggregate summary, and release manifest outputs |

Hidden reusable workflow files from the old `workflows` repository are retained
only when they still have an active compatibility or migration boundary. Retired
PR orchestration paths are not kept in `.github/workflows`; they remain listed
in the inventory as excluded legacy surfaces. In particular,
`.batch-pull-request.yml` is removed with the retired batch PR action family,
and the legacy `.release-new-version.yml` path is not the modern publish
surface. New publish integrations should use `.build.yml`, `buildchain.toml`,
`lifecycle.publish`, and publish transaction evidence.

Release templates that previously performed direct publishing or deployment are
now fail-closed when retained for compatibility discovery. They do not call
legacy publish actions, `npm publish`, or deploy providers directly. Callers must
migrate to `release-candidate-promote.yml@v2` or a project-owned
`lifecycle.publish` command behind a publish-gate source lock, so floating
`@v2` consumers cannot bypass source-lock drift protection.

The public promotion workflow is now a generated dual-channel router. Existing
callers remain source-compatible, while callers that want alpha workflow-shell
fixes before stable promotion should add `buildchain-channel: auto` plus
`buildchain-alpha-contract-lock-path` and
`buildchain-stable-contract-lock-path`. Keep one common promotion declaration;
do not duplicate alpha and stable jobs or call
`.release-candidate-promote.yml` directly.

Buildchain also keeps the workflow-file layout transition declarative in
`.buildchain/promotion-shell-routing.json`. Stable `v2.14.8` contains the hidden
advanced workflow, so the stable lane is pinned to that implementation's
immutable release SHA and forwards the full internal identity surface. This is
provider-owned compatibility state; consumers still keep the same single public
promotion job.

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
