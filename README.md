# Kungfu Buildchain

Kungfu Buildchain is the v1 source of truth for Kungfu reusable GitHub
workflows, GitHub Actions, and release-line automation.

The repository does more than collect workflow files. Its main job is to make a
Kungfu release auditable and repeatable: a protected branch merge should produce
the right version commit, exact release tag, floating channel tag, and next
alpha line without a maintainer hand-moving refs or repairing package metadata
after the fact.

## Why This Exists

Kungfu release automation has to solve a few problems at the same time:

- consumers need stable refs such as `v1`, `v1.0`, and `v1.0-alpha`;
- maintainers need exact immutable refs such as `v1.0.4` and
  `v1.0.5-alpha.0` for audit and rollback;
- package manifests must record the same version that the release tag
  advertises;
- alpha and release promotion must follow reviewed PRs, not local scripts or
  manually edited tags;
- the release toolchain itself must be released by the same governance model
  that it applies to product repositories.

The older ABV model solved this by treating a GitHub release PR as the release
intent. Buildchain v1 keeps that semantic contract, but implements it inside a
modern monorepo with Node 24 actions, pnpm, tsup bundles, committed `dist`
outputs, reusable workflow tests, package-manager adapters, and a TOML lifecycle
protocol for non-Node projects.

## Mental Model

Buildchain release automation is branch-driven:

| Merge path | Meaning | Exact tag | Floating tags and branches |
| --- | --- | --- | --- |
| `dev/vX/vX.Y -> alpha/vX/vX.Y` | publish the next testable alpha for a minor line | `vX.Y.Z-alpha.N` | `vX.Y-alpha`, `alpha/vX/vX.Y`, `dev/vX/vX.Y` |
| `alpha/vX/vX.Y -> release/vX/vX.Y` | publish production for that minor line | `vX.Y.Z` | `vX.Y`, usually `vX`, `release/vX/vX.Y` |
| `release/vX/vX.Y -> major-gate` | publish the next major from a reviewed production line | `v(X+1).0.0` | `v(X+1)`, `v(X+1).0`, `release/v(X+1)/v(X+1).0` |

After a production release, Buildchain prepares the next alpha source commit for
the same minor line and moves `dev/vX/vX.Y`, `alpha/vX/vX.Y`, and
`vX.Y-alpha` to that next prerelease state. This is why a release can leave the
production channel at `v1.0.4` while the test channel is already at
`v1.0.5-alpha.0`.

Kungfu treats minor lines as long-running product trains. `v1.0`, `v1.1`, and
future minor refs can each receive many patch releases such as `v1.0.1234`.
`v1` points at the selected stable major line, while `v1.0` points at the
latest production patch for that minor line.

`major-gate` replaces the old ABV `main` channel. It is deliberately not named
`main` because it is not the active development trunk. Maintainers use the same
PR flow as other channel promotions: merging `release/v1/v1.0 -> major-gate`
means "publish the next major line from this production state." The promotion
then creates the next major production version, for example `v2.0.0`, and
prepares `dev/v2/v2.0` plus `alpha/v2/v2.0` at `v2.0.1-alpha.0`.

Exact tags are always v-prefixed. Use `v1.0.0` and `v1.0.1-alpha.0`; bare tags
such as `1.0.0` are not maintained as Buildchain release entrypoints.

## Repository Layout

```text
.github/workflows/        Repository checks, reusable workflows, and release promotion
actions/                  GitHub Actions implementations, grouped by action
fixtures/                 Safe fixture repositories or fixture descriptors
packages/                 Shared libraries, added only when justified
tests/                    Inventory and contract data used by checks
docs/                     Governance, migration, architecture, and rollback notes
scripts/                  Local verification scripts
```

## Buildchain v1 Contract

Buildchain v1 ships these active migration surfaces:

- reusable workflows under `.github/workflows`;
- GitHub Actions under `actions/<name>`;
- action runtime on Node 24;
- workspace package management with pnpm;
- action bundling through tsup;
- committed `dist/index.js` bundles for direct GitHub Actions consumption;
- package-manager adapters for pnpm, npm, and yarn version-state updates;
- `buildchain.toml` lifecycle configuration for custom version files and
  verification commands;
- `actions/validate-config` migration preflight for TOML version-state and
  lifecycle declarations without running heavyweight builds;
- `.github/workflows/.build.yml` as the reusable build surface for
  tri-platform runner presets, custom runner matrices, caller-provided lifecycle
  commands, trusted event gating, artifact name templates, expected artifact
  checks, deterministic artifact manifests, and aggregate build summaries;
- `actions/run-lifecycle` for callers that need the same lifecycle/manifest
  contract inside their own workflows;
- governance-closed self-promotion through `Buildchain Ref Promotion`.

Stable consumers should reference actions as:

```yaml
uses: kungfu-systems/buildchain/actions/<name>@v1
```

Reusable workflows should be referenced as:

```yaml
uses: kungfu-systems/buildchain/.github/workflows/<workflow>.yml@v1
```

Standalone `workflows` and `action-*` repositories remain compatibility and
rollback anchors until consumers migrate to stable Buildchain refs.

## Release Governance

Buildchain promotes its own release refs through
`.github/workflows/buildchain-ref-promotion.yml` and
`actions/promote-buildchain-ref`.

The important constraints are:

- non-dry-run promotion is not available from manual dispatch;
- promotion must be backed by a protected same-repository PR channel path;
- protected channel details must be readable and must enforce protection for
  administrators;
- alpha promotion must come from `dev/vX/vX.Y -> alpha/vX/vX.Y`;
- release promotion must come from `alpha/vX/vX.Y -> release/vX/vX.Y`;
- major promotion must come from `release/vX/vX.Y -> major-gate`;
- release promotion must match an existing same-patch alpha tag tree;
- generated version-state commits must pass the configured verification command
  before refs move;
- `BUILDCHAIN_PROMOTION_TOKEN` is the release authority used to move protected
  refs when repository policy requires it.

Buildchain's top-level `Release - New Version` workflow is intentionally a
no-op for this repository. Consumer repositories still call the reusable
`.release-new-version.yml`; Buildchain itself is promoted only by
`Buildchain Ref Promotion` after `Verify` succeeds.

## Read Next

- [Release governance](docs/release-governance.md) explains the design problem,
  old ABV compatibility, hard constraints, and operational guarantees.
- [Release flow diagrams](docs/release-flow.md) gives the branch/tag state
  machine and Mermaid diagrams.
- [Migration inventory](docs/migration-inventory.md) lists migrated and retired
  action repositories.
- [Ownership rules](docs/ownership.md) defines source-of-truth and rollback
  boundaries.
- [promote-buildchain-ref](actions/promote-buildchain-ref/README.md) documents
  the internal promotion action.
- [Lifecycle protocol](docs/lifecycle-protocol.md) documents `buildchain.toml`
  for custom version-state files and lifecycle commands.
- [Reusable build surface](docs/reusable-build-surface.md) documents the build
  workflow, local runner matrix, artifact contract, and libnode-shaped fixture.

## Local Verification

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` validates inventory data, lints all root workflows including
hidden reusable workflows, and rebuilds every action bundle.

## Lifecycle Configuration

Projects can add `buildchain.toml` to declare release version state and
lifecycle commands. Buildchain v1 supports TOML only. The promotion action uses
configured version files to create source version commits, then runs
`lifecycle.verify` before moving release refs.

## Safety Defaults

- Lab workflows are manual by default.
- Publishing is disabled unless explicitly enabled by a production release
  workflow.
- Fork pull requests must not reach secrets or self-hosted runners.
- Candidate refs are expected to come from `kungfu-systems/*`.
- Self-hosted runner validation is available only through the manual
  `Self-hosted Runner Smoke` workflow.
