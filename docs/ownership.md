# Ownership And Migration Rules

## Source Of Truth

Buildchain v2 workflow and action design lands in this repository. Standalone
`workflows` and `action-*` repositories are historical rollback anchors.
Buildchain only ships the native action surface required for config validation,
lifecycle execution, and release ref promotion.

## Compatibility Rule

Do not break existing stable reusable workflow refs during migration:

- `kungfu-systems/workflows@v2`

Any consumer migration must record:

- old `uses:` refs;
- new `uses:` refs;
- workflow run ids;
- rollback command or revert path.

New stable references should use:

- `kungfu-systems/buildchain/actions/validate-config@v2`
- `kungfu-systems/buildchain/actions/run-lifecycle@v2`
- `kungfu-systems/buildchain/actions/promote-buildchain-ref@v2`
- `kungfu-systems/buildchain/.github/workflows/<workflow>.yml@v2`

## Publishing Rule

Publishing paths stay disabled in buildchain's own verification workflows unless
explicitly enabled by a production release workflow. Any consumer cutover that
publishes packages, S3 artifacts, release pages, or preview links must include
rollback notes. Reusable workflow consumers should gate publish jobs with
`needs.<build-job>.outputs.publish-allowed == 'true'` and record the requested
`publish-channel`, rather than duplicating channel branch logic in every
consumer workflow.

## Candidate Ref Rule

Candidate refs are expected to resolve under `kungfu-systems/*`. Broader
sources require an explicit trust decision before they can reach self-hosted
runners or secrets.

## Source-Locked Publish Rule

When a consumer uses `publish-gate/*` branches, publish jobs must use the
resolved `publish-source-sha` and `release-manifest-json` emitted by the reusable
build workflow. Before touching a package registry, S3 bucket, release page, or
floating alias, the publish job must verify that the gate branch still points at
the recorded SHA. A moved gate branch is a stale release decision, not a retry.
