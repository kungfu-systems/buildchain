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

Consumers that want Buildchain to select alpha for development/prerelease work
and stable for production releases use the channel router. The router defaults
to `auto`; repositories only add channel configuration when they intentionally
override that policy:

```yaml
uses: kungfu-systems/buildchain/.github/workflows/build.yml@v3
```

During v3 prerelease evaluation windows, canaries call the same router through
the matching prerelease ref:

```yaml
uses: kungfu-systems/buildchain/.github/workflows/build.yml@v3-alpha
```

The default policy selects `vN-alpha` for pull requests, development, nightly,
and prerelease intent; it selects stable `vN` for stable release intent. The
advanced `.build.yml` surface and explicit `buildchain-ref` train/SHA validation
remain available when a repository needs precise control.

For new repositories, prefer the CLI:

```sh
npx @kungfu-tech/buildchain init --type package
npx @kungfu-tech/buildchain validate --require-version-state
npx @kungfu-tech/buildchain release --dry-run --target-ref alpha/v3/v3.0
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

For temporary validation of an unreleased Buildchain runtime, keep the committed
workflow ref on `@v3` and use the trusted `workflow_dispatch` `buildchain-ref`
pass-through. See [`docs/runtime-train-validation.md`](docs/runtime-train-validation.md).

## Building this repo

Buildchain is a pnpm workspace running on Node 24:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run check
```

Buildchain v4 Stage Capsule checkpoint work is governed by
`architecture/v4-platform-stage-checkpoints.json`. Agents must use that single
platform/stage declaration for shadow emission and clean-process restore. Do
not add undeclared runner-only inputs, outputs, environment, provider effects,
credentials, or production stage-skipping authority.

Stage Capsule resume planning is governed by
`architecture/v4-stage-capsule-resume-planner.json`. Keep its Rust core and
TypeScript projection pure and byte-identical; explicit provider/release-tail
effects always require readback and never become Capsule reuse.

Stage Capsule qualification and Wave 2 reconciliation are governed by
`architecture/v4-stage-capsule-qualification.json`. Both Buildchain
self-dogfood and the exact-source Kungfu shadow consumer must pass the complete
three-platform, clean-process fault campaign. Qualification remains shadow-only:
it cannot enable production reuse, change v3 authority, perform provider or
release effects, or destroy retained state during rollback.

Buildchain self-dogfood must execute only the real `install` and `verify`
lifecycle declared in `.buildchain/buildchain.toml`, then bind its exact
manifest, summary, command, and output roots into the campaign profile.
Mutation stages such as `version-state` and `publish` remain excluded and must
never be invoked by Stage Capsule qualification.

`pnpm run check` validates inventory data, generated public references and site
bundle drift, lints root workflows, runs unit tests, and rebuilds every action
bundle.

Before broad maintenance or consolidation work, read the current engineering
handoff in
[`2026-07-10-buildchain-consolidation.md`](.github/retrospectives/2026-07-10-buildchain-consolidation.md).

## Proposing changes

- Open pull requests against the relevant `dev/*` channel branch.
- If a Buildchain change needs downstream validation before stable refs move,
  publish a `train/v3/v3.0/<capability>` ref and include the validation request
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
