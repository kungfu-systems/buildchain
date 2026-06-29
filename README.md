# Kungfu Buildchain

This repository is the development center for Kungfu release, verify, and
automation workflows.

It consolidates reusable GitHub workflows, tightly coupled release actions,
fixtures, and no-publish validation into one source tree. Existing standalone
workflow and action repositories remain compatibility surfaces until consumers
are migrated to stable buildchain refs.

## Layout

```text
.github/workflows/        Repository verification and no-publish lab workflows
actions/                  GitHub Actions implementations, grouped by action
fixtures/                 Safe fixture repositories or fixture descriptors
packages/                 Shared libraries, added only when justified
tests/                    Inventory and contract data used by checks
docs/                     Ownership, migration, and rollback notes
scripts/                  Local verification scripts
```

## Buildchain v1

Buildchain v1 is the monorepo source of truth for Kungfu reusable workflows and
GitHub Actions:

- reusable workflows live under `.github/workflows`;
- action implementations live under `actions/<name>`;
- all migrated actions build to committed `dist/index.js` bundles;
- action runtime is Node 24;
- workspace package management is pnpm;
- action bundling is handled by tsup.
- buildchain's own release-line and compatibility tags are promoted by the
  internal `promote-buildchain-ref` action after Verify succeeds: alpha branch
  creates or reuses the next exact prerelease tag such as
  `v1.0.1-alpha.0`, writes matching package version state, and promotes
  `v1.0-alpha`; release branch creates or reuses the next exact release tag
  such as `v1.0.0`, writes matching package version state, promotes the current
  minor tag such as `v1.0`, conditionally promotes `v1`, and prepares a
  matching source commit for the next exact prerelease tag on the minor line.

Stable consumers should reference actions as
`kungfu-systems/buildchain/actions/<name>@v1` and reusable workflows as
`kungfu-systems/buildchain/.github/workflows/<workflow>.yml@v1`.

Exact buildchain release and prerelease tags are always v-prefixed. Use
`v1.0.0` or `v1.0.1-alpha.0` for pinned refs; bare tags such as `1.0.0` are
not maintained as buildchain release entrypoints.

## Local Verification

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` validates the inventory, lints all root workflows including
hidden reusable workflows, and rebuilds every action bundle.

## Safety Defaults

- Lab workflows are manual by default.
- Publishing is disabled unless explicitly enabled later.
- Fork pull requests must not reach secrets or self-hosted runners.
- Candidate refs are expected to come from `kungfu-systems/*`.
- Old workflow and action repositories remain rollback anchors during migration.
- Self-hosted runner validation is available only through the manual
  `Agent 120 Smoke` workflow.
