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
last_reviewed: 2026-09-10
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-10
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

Use `@v4-alpha` for the alpha runtime. The called workflow ref and SHA determine
runtime identity and the matching contract lock. A nested project may supply
only `config-path`; all project settings belong in TOML and infrastructure
settings belong to a governed Buildchain environment profile. `.build.yml`
remains the core install/build/verify backbone. Historical build inputs and
runtime overrides are removed.

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

Ordinary builds do not accept runtime overrides. Specialized release/recovery
contracts retain their bounded, non-persistent validation mechanisms; see
[`docs/runtime-train-validation.md`](docs/runtime-train-validation.md).

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
and `verify` lifecycle. The public workflow binds the exact called-workflow SHA,
consumer source SHA, platform, commands, manifests, summaries, dependencies,
and output roots on Linux, macOS, and Windows.

No agent may add or restore a relative/self reusable-workflow call, direct
qualification job, local action, candidate-branch runtime override,
Buildchain-only consumer identity/profile, environment-variable escape hatch,
or any other private self-dogfood path. Generic Stage Capsule internals may be
called only by the public reusable workflow and tests. `version-state`,
`publish`, provider, signing, release, credential, AWS, and production-reuse
effects remain excluded.

External Buildchain v4 workflow calls persisted in tracked source use only `@v4` or
`@v4-alpha` and retain matching stable and alpha contract locks.
A source-persisted exact commit SHA, exact default, repository-variable indirection, nested
composite indirection, missing lock, or stale selected lock fails consumer
admission. Exact resolved SHAs remain evidence and runtime data, never a durable
selector.

Buildchain's own promotion callers invoke the same public promotion workflow by
repository-relative path, binding the caller and public API to the same commit.
Admission verifies the defining repository, exact Git commit, committed invocation
files, and both channel contract locks. This source-owned composition is confined
to `public-release-promote.yml`; it does not change the Stage Capsule public
floating-channel dogfood rule above. See `docs/release-promotion-request.md`.

If public Stage Capsule workflow recursion prevents candidate validation, publish the exact
candidate at `train/v4/v4.1/<capability>`, keep the thin caller on `@v4-alpha`,
and pass the train only through the trusted non-persistent runtime input. Fix
failures in the train/public contract; never solve recursion with an internal exception.
Never use a persisted train/SHA selector. After qualification and protected
merge, the durable caller remains on the floating channel with refreshed dual
contract locks. `pnpm run check` and protected Verify run
`scripts/check-public-dogfood-contract.mjs`; changing this rule, its gate, or
the protected caller requires independent `@kungfu-origin` review.

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
