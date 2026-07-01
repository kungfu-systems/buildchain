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

## npm Publish Gate

`.github/workflows/npm-publish.yml` publishes only on exact v-prefixed release
tags:

- `v2.0.13-alpha.0` publishes to npm with dist-tag `alpha`.
- `v2.0.13` publishes to npm with dist-tag `latest`.
- moving refs such as `v2`, `v2.0`, and `v2.0-alpha` do not match the publish
  workflow and do not publish.

The workflow uses npm Trusted Publishing through GitHub Actions OIDC. It runs
on a GitHub-hosted runner with `id-token: write`, verifies that the Git tag is
exactly `v${package.json.version}`, runs `pnpm run check`, and then runs:

```bash
npm publish --access public --tag <alpha|latest>
```

Before the first real release, configure npm Trusted Publishing for:

- package: `@kungfu-systems/buildchain`
- repository: `kungfu-systems/buildchain`
- workflow: `.github/workflows/npm-publish.yml`

No npm package is published by manual dispatch or by ordinary branch builds.
