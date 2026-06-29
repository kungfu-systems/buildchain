# Ownership And Migration Rules

## Source Of Truth

New buildchain workflow and action design should land in this repository.
Standalone `workflows` and `action-*` repositories are compatibility surfaces
until consumers migrate to stable buildchain refs.

## Compatibility Rule

Do not break existing stable refs during migration:

- `kungfu-systems/workflows@v2`
- `kungfu-systems/action-bump-version@v4`
- stable refs for active action repositories listed in `docs/migration-inventory.md`

Any consumer migration must record:

- old `uses:` refs;
- new `uses:` refs;
- workflow run ids;
- rollback command or revert path.

## Publishing Rule

No Phase 1 workflow may publish releases, packages, S3 artifacts, release pages,
or preview links. Publishing paths must be added only with explicit production
cutover work and rollback notes.

## Candidate Ref Rule

Candidate refs are expected to resolve under `kungfu-systems/*`. Broader
sources require an explicit trust decision before they can reach self-hosted
runners or secrets.

