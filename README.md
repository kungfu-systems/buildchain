# Buildchain

[![Verify](https://github.com/kungfu-systems/buildchain/actions/workflows/verify.yml/badge.svg?branch=dev%2Fv2%2Fv2.8)](https://github.com/kungfu-systems/buildchain/actions/workflows/verify.yml)
[![Release Gate](https://github.com/kungfu-systems/buildchain/actions/workflows/buildchain-ref-promotion.yml/badge.svg)](https://github.com/kungfu-systems/buildchain/actions/workflows/buildchain-ref-promotion.yml)
[![npm latest](https://img.shields.io/npm/v/%40kungfu-tech%2Fbuildchain/latest?label=npm%20latest)](https://www.npmjs.com/package/@kungfu-tech/buildchain)
[![npm alpha](https://img.shields.io/npm/v/%40kungfu-tech%2Fbuildchain/alpha?label=npm%20alpha)](https://www.npmjs.com/package/@kungfu-tech/buildchain?activeTab=versions)
[![GitHub Release](https://img.shields.io/github/v/release/kungfu-systems/buildchain?label=release)](https://github.com/kungfu-systems/buildchain/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![KFD-1](https://img.shields.io/badge/KFD--1-contract%20world-2ea44f.svg)](docs/release-passport.md#kfd-1-contract-world-release-gate)
[![KFD-2](https://img.shields.io/badge/KFD--2-trust%20passport-0969da.svg)](docs/release-passport.md#kfd-2-release-trust-passport-audit)
[![KFD-3](https://img.shields.io/badge/KFD--3-collaboration%20interface-8250df.svg)](docs/release-passport.md#kfd-3-collaboration-interface-release-gate)
![Status: Stable](https://img.shields.io/badge/status-stable-brightgreen.svg)
![Platforms: macOS | Linux | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)

Buildchain Release Passport is a mature product release record for artifacts
that users or agents depend on.

Buildchain by Kungfu uses GitHub as the execution and trust substrate: protected
refs, reviewed promotion PRs, exact tags, GitHub Releases, npm Trusted
Publishing, and machine-readable evidence. Its job is to turn release intent
into an auditable product record, not to ask a repository to migrate away from
its existing CI.

The same mechanism releases Buildchain itself.

## Install and Verify

For standalone use, install a platform archive from a GitHub Release and verify
the release passport before trusting the binary:

```bash
# Example for Linux x64. Use the archive that matches your platform.
curl -LO https://github.com/kungfu-systems/buildchain/releases/download/v2.2.1/buildchain-x86_64-unknown-linux-gnu.tar.gz
curl -LO https://github.com/kungfu-systems/buildchain/releases/download/v2.2.1/buildchain.release.json
curl -LO https://github.com/kungfu-systems/buildchain/releases/download/v2.2.1/artifact-evidence.json
npx @kungfu-tech/buildchain verify release-passport buildchain.release.json
tar -xzf buildchain-x86_64-unknown-linux-gnu.tar.gz
./buildchain version
```

Release pages publish platform archives, checksums, release passport files, and
a single evidence bundle:

- `buildchain-x86_64-unknown-linux-gnu.tar.gz`
- `buildchain-aarch64-apple-darwin.tar.gz`
- `buildchain-x86_64-pc-windows-msvc.zip`
- `checksums.txt`
- `buildchain.release.json`
- `artifact-evidence.json`
- `product-mechanism.json`
- `impact.json`
- `agent-index.json`
- `check-report.json`
- `llms.txt`
- `buildchain-release-bundle.tar.gz`
- `buildchain-release-bundle.json`

Loose top-level `buildchain` and `buildchain.exe` assets are intentionally not
published. The executable lives inside each platform archive, which prevents
Linux and macOS artifacts from overwriting each other in a merged release lane.

For npm consumers:

```bash
npm install -D @kungfu-tech/buildchain
npx buildchain version
npx buildchain doctor --json
```

The npm package is also the Buildchain toolkit. Use the command when a workflow
or shell step needs an executable; use the ESM APIs directly from JavaScript
build scripts. JavaScript callers should import the package instead of spawning
the CLI or unpacking the standalone binary:

```js
import {
  createBuildchainLogger,
  verifyBuildchainLogEvents,
} from "@kungfu-tech/buildchain/logging";

const logger = createBuildchainLogger({
  path: ".buildchain/logs/native-build.jsonl",
  source: "user",
  component: "native-build",
});

await logger.span("native.compile", { phase: "build" }, async () => {
  await compileNativeTargets();
});

const report = verifyBuildchainLogEvents({
  path: logger.path,
  requireEvents: ["native.compile.start", "native.compile.end"],
});
```

The package also ships `dist/site/` as the Buildchain-owned fact source for
`buildchain.libkungfu.dev`.

## Project Governance

- [`LICENSE-POLICY.md`](LICENSE-POLICY.md) explains the Apache-2.0 project
  license, DCO-based contributions, and third-party notice boundary.
- [`TRADEMARK.md`](TRADEMARK.md) explains official project marks and fork
  identity boundaries.
- [`ACCEPTABLE_USE.md`](ACCEPTABLE_USE.md) explains acceptable use of official
  services and maintainer-operated infrastructure.
- [`PROVIDER_COMPLIANCE.md`](PROVIDER_COMPLIANCE.md) explains the official
  posture for GitHub, npm, cloud, credential, release evidence, and other
  provider integrations.
- [`SECURITY.md`](SECURITY.md) explains private vulnerability reporting.

Native build consumers can import the diagnostics toolkit instead of copying
repository-local probes:

```js
import {
  collectBuildchainDiagnostics,
  collectRunnerDiagnostics,
  writeDiagnosticsArtifact,
} from "@kungfu-tech/buildchain/diagnostics";

writeDiagnosticsArtifact(".buildchain/artifacts/diagnostics.json", {
  contract: "consumer-build-diagnostics",
  buildchain: collectBuildchainDiagnostics({ cwd: process.cwd() }),
  runner: collectRunnerDiagnostics(),
});
```

`buildchain lifecycle run` writes a small `diagnostics.json` next to the
platform manifest. It includes lifecycle-wide observability, runner/tool/cache
snapshots, Git state, and links to the larger manifest and artifact outputs.

Consumers can report Buildchain-owned workflow failures directly to the
Buildchain repository with a scoped issue-write token:

```yaml
- uses: kungfu-systems/buildchain/actions/report-buildchain-issue@v2
  if: failure()
  with:
    token: ${{ steps.buildchain-issue-token.outputs.token }}
    summary: "Reusable build failed before artifact finalization"
    failure-code: reusable-build-failed
    buildchain-ref: v2
    diagnostics-path: .buildchain/artifacts/diagnostics.json
```

The action deduplicates by fingerprint, comments on existing open reports, and
is fail-soft by default so issue reporting does not hide the original failure.
Use `report-kind: workflow-friction` when Buildchain workflows should report
their own repeated release friction back to the Buildchain issue tracker.

## Use Buildchain

Bootstrap a repository:

```bash
npx @kungfu-tech/buildchain init --type package --package-manager pnpm
npx @kungfu-tech/buildchain validate --require-version-state
npx @kungfu-tech/buildchain release --dry-run --target-ref alpha/v2/v2.2
```

Buildchain supports package and non-package projects through `buildchain.toml`.
Lifecycle commands can call pnpm, npm, yarn, pip, Conan, CMake, Make, custom
scripts, or any other command that can run in the repository checkout.

Buildchain's active GitHub Action surface is deliberately small:

- `actions/validate-config`
- `actions/run-lifecycle`
- `actions/promote-buildchain-ref`
- `actions/report-buildchain-issue`

The active reusable workflow surfaces are:

- `.github/workflows/.build.yml` for deterministic multi-platform build and
  artifact contracts;
- `.github/workflows/release-candidate-promote.yml` for post-merge
  promote-only publication from a PR-stage release candidate, without a second
  heavy build;
- `.github/workflows/.web-surface.yml` for preview, staging, production, and
  cleanup plans for site/app repositories;
- `.github/workflows/buildchain-ref-promotion.yml` for protected release
  promotion and version-state transactions;
- `.github/workflows/binary-distribution.yml` for Buildchain's own release
  passport proof case.

Stable consumers should reference actions and workflows through floating major
refs after reviewing the exact release passport:

```yaml
uses: kungfu-systems/buildchain/actions/validate-config@v2
```

```yaml
uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
```

```yaml
uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v2
```

## Release Model

Buildchain treats a reviewed branch merge as release intent:

| Merge path | Meaning | Exact tag | Floating refs |
| --- | --- | --- | --- |
| `dev/vX/vX.Y -> alpha/vX/vX.Y` | publish the next testable alpha for a minor line | `vX.Y.Z-alpha.N` | `vX.Y-alpha`, `alpha/vX/vX.Y`, `dev/vX/vX.Y` |
| `alpha/vX/vX.Y -> release/vX/vX.Y` | publish production for that minor line | `vX.Y.Z` | `vX.Y`, usually `vX`, `release/vX/vX.Y` |
| `release/vX/vX.Y -> publish-gate/major` | publish the next major from a reviewed production line | `v(X+1).0.0` | `v(X+1)`, `v(X+1).0`, new dev/alpha/release branches |

Exact tags are immutable. Floating channel tags and branches are machine-updated
by Buildchain and must remain writable by the release authority.

After a production release, Buildchain prepares the next alpha source commit for
the same minor line. That keeps production consumers pinned to the production
passport while development can continue on the next testable patch.

`publish-gate/major` is not an active development trunk. It is a reviewed
promotion gate used when maintainers decide that the next production release
should open a new major line.

## Toolkit Observability

Buildchain includes a logging toolkit for release and build steps. Inside
JavaScript build code, prefer the package API:

```js
import { createBuildchainLogger } from "@kungfu-tech/buildchain/logging";

const logger = createBuildchainLogger({ source: "user", component: "conan" });
logger.mark("conan.profile.ready", { phase: "configure" });
await logger.span("conan.install", { phase: "dependencies" }, runConanInstall);
```

In workflows or shell scripts, use the equivalent CLI:

```bash
buildchain mark --event native.configure --phase configure --component cmake
buildchain span --event native.build --phase build -- cmake --build build
buildchain log summary --json
buildchain verify observability-log .buildchain/logs/events.jsonl --min-events 4
```

Every event records a timestamp. `span` records duration. The API form can be
imported from repository scripts so heavy builds can mark phases from inside
their own code.

## Site Fact Source

`@kungfu-tech/buildchain` publishes `dist/site/`:

- `buildchain-site.json`
- `site-manifest.json`
- `page-registry.json`
- `cli-registry.json`
- `workflow-registry.json`
- `release-model.json`
- `artifact-schemas.json`
- `product-mechanism.json`
- `release-provenance.json`
- `agent-index.json`

`buildchain.libkungfu.dev` should render from these package-owned facts, then
layer presentation around them. The site should not hand-write Buildchain's
current release mechanics. `page-registry.json` is the complete markdown page
source for the public site: README homepage content, all packaged `docs/*.md`
manuals, action READMEs, the Node API package overview, and fixture guides.

## Homepage Content Contract

This README is also the homepage text source for `buildchain.libkungfu.dev`.
When a site repository consumes the `@kungfu-tech/buildchain` npm package, it
should use the generated `dist/site/buildchain-site.json` homepage fields
instead of parsing this README or maintaining separate homepage copy.

The first screen should be derived from:

- Page identity: the top-level heading.
- Lead: the opening paragraph that defines Buildchain Release Passport.
- Trust signal: the start of `Install and Verify`, especially passport-first
  binary verification.
- Use signal: the start of `Use Buildchain`, especially the reusable workflow
  and action surfaces.

The package-owned site bundle exposes ordered `homepage.sections`,
`homepage.displayPlan`, `homepage.rendererContract`, and a complete
`pages` collection mirrored from `page-registry.json`. A site renderer may adapt
layout, navigation, typography, examples, and visual assets, but it should not
maintain separate wording for Buildchain's release mechanics, workflow surface,
operation manuals, Node API overview, fixture guides, or release-passport trust
model. Renderer-contract text is machine/implementation metadata, not ordinary
homepage content.

## Local Verification

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run generate:site
pnpm run check
npm pack --dry-run --json --registry=https://registry.npmjs.org/
```

## Read Next

- [Install and verify](docs/install.md)
- [Documentation map](docs/MAP.md)
- [Product mechanism](docs/product-mechanism.md)
- [Release Passport and binary distribution](docs/release-passport.md)
- [Binary distribution details](docs/binary-distribution.md)
- [Toolkit observability](docs/toolkit-observability.md)
- [Site bundle contract](docs/site-bundle-contract.md)
- [Lifecycle protocol](docs/lifecycle-protocol.md)
- [Reusable build surface](docs/reusable-build-surface.md)
- [Release candidate passport](docs/release-candidate.md)
- [Consumer issue reporting](docs/consumer-issue-reporting.md)
- [Publish transaction](docs/publish-transaction.md)
- [Release governance](docs/release-governance.md)
