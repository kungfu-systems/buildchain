# Contributing to Buildchain

Thanks for your interest in Buildchain. This guide covers how to build the
project, the repository conventions, and how changes are proposed and released.

## Feedback, questions & security

All project contact happens through GitHub - there is no email support channel.

- **Bugs, feature requests, questions, documentation issues** - open a
  [GitHub issue](https://github.com/kungfu-systems/buildchain/issues/new/choose).
- **Code and documentation changes** - open a pull request.
- **Security vulnerabilities** - report them privately, never in a public issue.
  See [`SECURITY.md`](SECURITY.md).

Please do not include secrets, credentials, tokens, private logs, or other
sensitive material in issues or pull requests.

## Prerequisites

- Node.js 24
- Corepack with pnpm 11
- Go 1.25 for workflow validation paths that exercise Go setup

Buildchain's reusable workflow consumers may build with npm, yarn, pnpm, CMake,
Conan, Python, Docker, or other tools through lifecycle commands. This
repository itself is a Node/pnpm workspace.

## Repository layout

- `.github/workflows` - repository checks, reusable workflows, and Buildchain
  self-promotion.
- `actions` - the active GitHub Actions surface:
  `validate-config`, `run-lifecycle`, and `promote-buildchain-ref`.
- `bin` - the published `buildchain` command-line entrypoint.
- `docs` - release governance, lifecycle, reusable workflow, web-surface, and
  CLI documentation.
- `fixtures` - safe shape fixtures used by tests and reusable workflow checks.
- `packages/core` - shared ESM library code used by CLI and scripts.
- `scripts` - local and workflow runtime scripts.
- `tests` - Node test runner suites and inventory contracts.

Standalone historical `action-*` repositories are not mirrored here as active
actions. See [`docs/migration-inventory.md`](docs/migration-inventory.md).

## Build and verification

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` performs the repository done-check:

- validates inventory data;
- lints all root workflows, including hidden reusable workflows;
- runs unit tests with `node --test`;
- rebuilds action bundles through each action package.

For narrower checks during development:

```sh
pnpm run test:unit
pnpm run check:workflows
pnpm run build
npm pack --dry-run --json --registry=https://registry.npmjs.org/
```

## Generated files

GitHub Actions consume committed bundles. When changing an action
implementation, run the action build and commit the updated `dist/index.js`
alongside the source files.

## Commit messages

- Write commit messages and pull request descriptions in **English**.
- Follow lightweight [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`), for example `fix(publish): resume finalizing refs`.
- Sign every commit with the Developer Certificate of Origin:

```sh
git commit -s -m "docs: add public repository onboarding"
```

The sign-off adds a line like:

```text
Signed-off-by: Your Name <you@example.com>
```

Pull requests are checked automatically; every commit must include this line.

## Branches, pull requests & releases

Development happens on channel branches per version line, promoted by pull
request:

```text
dev/vX/vX.Y -> alpha/vX/vX.Y -> release/vX/vX.Y
release/vX/vX.Y -> publish-gate/major
```

- Open normal changes against the relevant `dev/*` branch.
- When a Buildchain change needs downstream validation before stable refs move,
  publish a temporary runtime train ref such as
  `train/v2/v2.3/<capability>` and ask consumers to run trusted
  `workflow_dispatch` with `buildchain-ref` set to that train. Keep the pull
  request against the `dev/*` branch; the train is only a validation pointer,
  not a pending merge target. After validation succeeds, merge into the active
  `dev/*` mainline and run the requested alpha or release promotion. The train
  may remain for a retention window as a fast-use and rollback channel; old
  trains are cleaned by a separate periodic cleanup task.
- Merging into `alpha/*`, `release/*`, or `publish-gate/major` expresses a
  release intent. Buildchain promotion then creates version-state commits,
  exact tags, floating tags, npm publish evidence, and next-alpha state.
- Manual promotion dispatch is dry-run only; non-dry-run promotion follows a
  successful protected workflow path.

See [`docs/release-governance.md`](docs/release-governance.md),
[`docs/release-flow.md`](docs/release-flow.md), and
[`docs/runtime-train-validation.md`](docs/runtime-train-validation.md).

## License

By contributing you agree that your contributions are licensed under the
project's [Apache License 2.0](LICENSE). Buildchain uses the Developer
Certificate of Origin (DCO) and does not require a Contributor License Agreement
(CLA).
