---
status: active
period: ongoing
theme: buildchain-layered-architecture
doc_type: implementation-guide
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-11
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-11
  visible_context: Buildchain 4.1 source, architecture registries and local validation.
  invisible_context_boundary: No unpublished release or external consumer qualification is claimed.
---

# AGENTS.md

This file orients coding agents and people working with Buildchain. It is a
router, not a duplicate: it points to the authoritative documents rather than
restating them.

## Are you using Buildchain, or building it?

- **Adopting Buildchain for the first time** - follow the 15-30 minute
  [`Golden Path`](docs/getting-started.md).
- **Looking up a CLI command** - use the generated
  [`CLI Reference`](docs/cli-reference.md).
- **Writing Node build automation** - use the generated
  [`Node API Reference`](docs/node-api-reference.md).
- **Exploring advanced workflows, release governance, or product
  capabilities** - start at the [`Documentation Map`](docs/MAP.md).
- **Building or contributing to this repo** - read the rest of this file, then
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Using this repo as a Buildchain consumer

Ordinary builds read project configuration from `buildchain.toml`. Single-project
consumers call the public workflow with no inputs:

```yaml
uses: kungfu-systems/buildchain/.github/workflows/build.yml@v4
```

The public workflow is the API entry. It selects the execution runtime from a
trusted non-persistent runtime input (`runtime-ref`), the selected consumer
contract lock, or the entry commit default. `@v4-alpha` selects the alpha entry
and its default lock path. Entry and runtime commits may differ. See
[`Runtime entry`](docs/runtime-entry.md) for selection and recovery.

Project settings belong in TOML; `config-path` locates a nested project. All
execution jobs prepare the selected runtime through
`actions/runtime/environment/prepare`. Subsequent business actions use that
runtime without Buildchain SHA comparisons or secondary runtime admission.

For new repositories, prefer the CLI:

```sh
npx @kungfu-tech/buildchain init --type package
npx @kungfu-tech/buildchain validate --require-version-state
npx @kungfu-tech/buildchain release --dry-run --target-ref alpha/v4/v4.1
```

For governed Paper repositories, scaffold or migrate the repository once, then
follow the generated `AGENTS.md` entry contract. Work begins and ends through
the pinned pnpm scripts:

```sh
pnpm paper:agent:verify
pnpm paper:work:start -- <topic> --execute --json
pnpm paper:work:submit -- --execute --json
```

The reusable required check independently enforces the same contract and PR
lineage, so local command use is never treated as remote acceptance evidence.

See [`docs/cli.md`](docs/cli.md), [`docs/lifecycle-protocol.md`](docs/lifecycle-protocol.md),
and [`docs/reusable-build-surface.md`](docs/reusable-build-surface.md) for the
consumer contract.

All public entries share the same runtime contract. A runtime bug is recovered
through a new execution with a repaired train and original source evidence.
An entry bug requires an upgraded published entry and a complete new run.

## Building this repo

Read [Code organization](docs/code-organization.md) before changing implementation
layout. Keep workflows, action adapters, JavaScript modules and Rust domains in
their declared responsibility layers. No historical compatibility entry is retained.

Buildchain is a pnpm workspace running on Node 24:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run check
```

Workflow paths are governed by [`architecture/workflow-taxonomy.json`](architecture/workflow-taxonomy.json)
and the generated [`Workflow Catalog`](docs/workflow-catalog.md). Before adding,
renaming, or editing workflow YAML, register its role (`public`, component `.`,
or `self`) and category (`build`, `release`, or `ops`). Use the derived filename;
do not invent prefixes, categories, or compatibility aliases. Edit canonical
implementations, run `pnpm run generate:workflows`, and pass
`pnpm run check:workflows` plus the full check. Taxonomy and gate changes require
independent `@kungfu-origin` review through CODEOWNERS.

Buildchain v4 Stage Capsule checkpoint work is governed by
`architecture/platform-stage-checkpoints.json`. Agents must use that single
platform/stage declaration for shadow emission and clean-process restore. Do
not add undeclared runner-only inputs, outputs, environment, provider effects,
credentials, or production stage-skipping authority.

Stage Capsule resume planning is governed by
`architecture/stage-capsule-resume-planner.json`. Keep its Rust core and
TypeScript projection pure and byte-identical; explicit provider/release-tail
effects always require readback and never become Capsule reuse.

Stage Capsule qualification and Wave 2 reconciliation are governed by
`architecture/stage-capsule-qualification.json`. Buildchain v4 dogfood is a
repository invariant, not an implementation convenience: this repository must
consume `kungfu-systems/buildchain/.github/workflows/public-build-stage-capsule-canary.yml`
through the same public reusable-workflow contract as every other consumer.
The caller must remain a thin workflow with no steps or local orchestration,
and `.buildchain/buildchain.toml` must declare the same real `install`, `build`,
and `verify` lifecycle. The public workflow records the entry and selected runtime and binds
consumer source SHA, platform, commands, manifests, summaries, dependencies,
and output roots on Linux, macOS, and Windows.

Dogfood callers use the same public entry and runtime preparation as external
consumers. No repository-specific runtime selection or recovery exception is
allowed. Stage Capsule internals are invoked by public workflows and tests;
provider effects remain subject to their own source, artifact and readback rules.

External Buildchain v4 workflow calls persisted in tracked source use only `@v4` or
`@v4-alpha` and retain matching stable and alpha contract locks. A
source-persisted exact commit SHA or train is not a durable entry selector.
Exact resolved SHAs belong in lock data and provenance. Normal self workflows
call `@v4`; dedicated post-publication alpha entry qualification calls `@v4-alpha`.

Train validation passes `train/v4/v4.1/<capability>` only through the trusted
non-persistent runtime input. The central entry resolves it once, and every
business job executes the selected runtime. Protected merge and requested alpha
publication follow successful validation. Changes to dogfood policy or its
gates require independent `@kungfu-origin` review.

`pnpm run check` validates inventory data, generated public references and site
bundle drift, lints root workflows, runs unit tests, and rebuilds every action
bundle.

Before broad maintenance or consolidation work, read the current engineering
handoff in
[`2026-07-10-buildchain-consolidation.md`](.github/retrospectives/2026-07-10-buildchain-consolidation.md).

## Proposing changes

- Open pull requests against the relevant `dev/*` channel branch.
- If a Buildchain change needs downstream validation before stable refs move,
  publish a `train/v4/v4.1/<capability>` ref and include the validation request
  described in [`docs/runtime-train-validation.md`](docs/runtime-train-validation.md).
  After validation succeeds, do not leave the train as a pending merge item:
  merge the pull request into the active `dev/*` mainline and run the requested
  alpha or release promotion. The train may remain for a retention window as a
  fast-use and rollback channel; periodic cleanup handles old trains.
- Write commit messages and PR descriptions in English, using lightweight
  [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`).
- Sign off every commit with the DCO: `git commit -s`.
- Bugs, feature requests, questions, and documentation issues go through GitHub
  issues; security vulnerabilities use private vulnerability reporting - see
  [`SECURITY.md`](SECURITY.md).
- Brand, hosted-service, and upstream-provider boundaries are documented in
  [`TRADEMARK.md`](TRADEMARK.md), [`ACCEPTABLE_USE.md`](ACCEPTABLE_USE.md), and
  [`PROVIDER_COMPLIANCE.md`](PROVIDER_COMPLIANCE.md).

## Ground rules

- Never include secrets, credentials, tokens, or private logs in code, commits,
  issues, or pull requests.
- Do not build or document official release integrations that bypass provider
  protections, hide credential boundaries, or forge release evidence.
- Keep generated action bundles in sync with source changes.
- When public documentation, CLI usage authority, or package exports change,
  follow the [Site Bundle Contract generation steps](docs/site-bundle-contract.md#generation)
  and commit the updated generated references and `dist/site/` facts.
- Keep documentation in sync with behavior, especially release governance and
  reusable workflow contracts.
- [`docs/MAP.md`](docs/MAP.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md) are the
  sources of truth; when this summary and they disagree, follow them.
