# Buildchain CLI and npm Package

Buildchain is published as the public npm package
`@kungfu-systems/buildchain`. The package contains the `buildchain` command,
the shared core libraries, and the local scripts needed to initialize and
validate repositories before they use the reusable GitHub workflow surface.

The npm package is not the release authority. Release authority still comes
from the protected Buildchain branch and tag state machine. npm publishing is a
side effect of an exact release tag that has already been produced by that
state machine.

## Install and Run

Use the published package directly:

```bash
npx @kungfu-systems/buildchain --help
npx @kungfu-systems/buildchain init --type package
npx @kungfu-systems/buildchain validate --require-version-state
```

Or install it in a repository:

```bash
pnpm add -D @kungfu-systems/buildchain
pnpm exec buildchain validate
```

## Commands

`buildchain init` writes a starter `buildchain.toml` and a reusable workflow
caller at `.github/workflows/build.yml`.

Supported presets:

- `--type package` for Node package repositories with pnpm, npm, or yarn.
- `--type native` for CMake-style native projects.
- `--type web-surface` for preview/staging/production site or app deployments.
- `--type anchored-package` for packages whose version is anchored to an
  explicit upstream release manifest.

`buildchain validate` parses `buildchain.toml`, checks configured version-state
files, and can require named lifecycle stages:

```bash
buildchain validate \
  --require-version-state \
  --require-lifecycle-stages install,build,verify
```

`buildchain lifecycle run <stage>` executes a lifecycle stage and writes the
same deterministic artifact manifest contract used by the reusable workflow:

```bash
buildchain lifecycle run build \
  --artifact-path dist \
  --artifact-name "{repo}-{version}-{platform}"
```

`buildchain release`, `buildchain web-surface`, `buildchain publish-source`,
and `buildchain build-contract` route to the same scripts used by Buildchain's
GitHub Actions workflows. This keeps local inspection and CI behavior on the
same implementation path.

`buildchain release --dry-run` explains the release-line state machine before a
maintainer opens or merges a channel PR:

```bash
buildchain release --dry-run --target-ref alpha/v2/v2.0
buildchain release --dry-run --target-ref release/v2/v2.0 --sha <verified-sha>
buildchain release dry-run --target-ref publish-gate/major --source-ref release/v2/v2.0
```

This is a Buildchain-level dry-run, not an npm dry-run. It explains the legal
source branch, exact release or alpha tags, floating tags, channel branches,
version-state files, governance checks, and publish transaction behavior that
would apply if the corresponding PR merge were promoted. It does not move
branches, move tags, edit files, publish npm packages, or run lifecycle publish
commands. Pass `--json` for a machine-readable plan.

`buildchain npm dry-run` verifies the package shape before a release tag exists:

```bash
buildchain npm dry-run --json
```

The command validates `package.json`, infers the exact release tag
`v${package.json.version}`, chooses npm dist-tag `alpha` for prereleases and
`latest` for stable releases, runs `npm pack --dry-run --json`, and then runs
`npm publish --dry-run --access public --tag <alpha|latest>` unless
`--skip-npm-publish-dry-run` is passed. It never performs a real publish.

## npm Publish Gate

Buildchain's own npm package is published from
`.github/workflows/buildchain-ref-promotion.yml`, inside the same publish
transaction that promotes release refs:

- `v2.0.13-alpha.0` publishes to npm with dist-tag `alpha`.
- `v2.0.13` publishes to npm with dist-tag `latest`.
- moving refs such as `v2`, `v2.0`, and `v2.0-alpha` do not match the publish
  workflow and do not publish.

The promotion workflow uses npm Trusted Publishing through GitHub Actions OIDC.
It runs on a GitHub-hosted runner with `id-token: write`, generates the
version-state commit, runs `lifecycle.verify`, runs `lifecycle.publish`, writes
Buildchain publish evidence, validates that evidence, and only then moves exact
tags and floating refs.

```bash
node scripts/npm-publish-transaction.mjs
```

Before the first real release, configure npm Trusted Publishing for:

- package: `@kungfu-systems/buildchain`
- repository: `kungfu-systems/buildchain`
- workflow: `.github/workflows/buildchain-ref-promotion.yml`

No npm package is published by manual dispatch or ordinary branch builds.
Manual dispatch on `.github/workflows/npm-publish.yml` remains dry-run only, so
maintainers can verify package contents and npm publish shape before opening or
merging the release PR.
