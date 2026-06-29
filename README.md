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

## Current Phase

Phase 1 creates the monorepo foundation only:

- inventory current buildchain repositories;
- keep old stable refs available;
- add baseline structure and safe checks;
- keep publishing disabled by default;
- avoid production consumer changes.

The buildchain repository is not complete until it can verify, version, and
release itself through the buildchain path, and at least one low-risk consumer
plus the core Kungfu release path have been migrated to a stable monorepo ref.

## Safety Defaults

- Lab workflows are manual by default.
- Publishing is disabled unless explicitly enabled later.
- Fork pull requests must not reach secrets or self-hosted runners.
- Candidate refs are expected to come from `kungfu-systems/*`.
- Old workflow and action repositories remain rollback anchors during migration.

