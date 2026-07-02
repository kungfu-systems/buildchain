# AGENTS.md

This file orients coding agents and people working with Buildchain. It is a
router, not a duplicate: it points to the authoritative documents rather than
restating them.

## Are you using Buildchain, or building it?

- **Using Buildchain** - initialize a repository, call a reusable workflow, run
  a release dry-run, or inspect the release model: start at the documentation
  map, [`docs/MAP.md`](docs/MAP.md).
- **Building or contributing to this repo** - read the rest of this file, then
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Using this repo as a Buildchain consumer

Stable consumers should pin actions and reusable workflows through the released
Buildchain refs:

```yaml
uses: kungfu-systems/buildchain/actions/validate-config@v2
uses: kungfu-systems/buildchain/actions/run-lifecycle@v2
uses: kungfu-systems/buildchain/actions/promote-buildchain-ref@v2
uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
```

For new repositories, prefer the CLI:

```sh
npx @kungfu-tech/buildchain init --type package
npx @kungfu-tech/buildchain validate --require-version-state
npx @kungfu-tech/buildchain release --dry-run --target-ref alpha/v2/v2.2
```

See [`docs/cli.md`](docs/cli.md), [`docs/lifecycle-protocol.md`](docs/lifecycle-protocol.md),
and [`docs/reusable-build-surface.md`](docs/reusable-build-surface.md) for the
consumer contract.

## Building this repo

Buildchain is a pnpm workspace running on Node 24:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` validates inventory data, lints root workflows, runs unit tests,
and rebuilds every action bundle.

## Proposing changes

- Open pull requests against the relevant `dev/*` channel branch.
- Write commit messages and PR descriptions in English, using lightweight
  [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`).
- Sign off every commit with the DCO: `git commit -s`.
- Bugs, feature requests, questions, and documentation issues go through GitHub
  issues; security vulnerabilities use private vulnerability reporting - see
  [`SECURITY.md`](SECURITY.md).

## Ground rules

- Never include secrets, credentials, tokens, or private logs in code, commits,
  issues, or pull requests.
- Keep generated action bundles in sync with source changes.
- Keep documentation in sync with behavior, especially release governance and
  reusable workflow contracts.
- [`docs/MAP.md`](docs/MAP.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md) are the
  sources of truth; when this summary and they disagree, follow them.
