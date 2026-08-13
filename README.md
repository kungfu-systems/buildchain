# Buildchain

<!-- buildchain-auditable-demo:start -->
## Buildchain beginner bootstrap

[![Buildchain beginner bootstrap](docs/evidence/auditable-demo/a5807fa19a55a5e454187890de90b48a474b9147b760fd6028af1a3a9df3ab31/beginner-bootstrap/demo.gif)](docs/evidence/auditable-demo/a5807fa19a55a5e454187890de90b48a474b9147b760fd6028af1a3a9df3ab31/beginner-bootstrap/public-evidence.json)

Animation scenario:

```text
$ buildchain init --cwd ./starter --type package --package-manager npm
$ buildchain layout --cwd ./starter --json
$ buildchain version
```

Native renditions: [1080p MP4](docs/evidence/auditable-demo/a5807fa19a55a5e454187890de90b48a474b9147b760fd6028af1a3a9df3ab31/beginner-bootstrap/demo.mp4) · [1080p WebM](docs/evidence/auditable-demo/a5807fa19a55a5e454187890de90b48a474b9147b760fd6028af1a3a9df3ab31/beginner-bootstrap/demo.webm) · [720p MP4](docs/evidence/auditable-demo/a5807fa19a55a5e454187890de90b48a474b9147b760fd6028af1a3a9df3ab31/beginner-bootstrap/demo-720p.mp4) · [720p WebM](docs/evidence/auditable-demo/a5807fa19a55a5e454187890de90b48a474b9147b760fd6028af1a3a9df3ab31/beginner-bootstrap/demo-720p.webm)

[Static poster / reduced-motion fallback](docs/evidence/auditable-demo/a5807fa19a55a5e454187890de90b48a474b9147b760fd6028af1a3a9df3ab31/beginner-bootstrap/poster.png)

<details>
<summary>Evidence and claim boundary</summary>

This exact standalone-binary scenario proves deterministic local bootstrap behavior only; it does not grant release, repository, network, or production authority.

[Release Passport](docs/evidence/auditable-demo/a5807fa19a55a5e454187890de90b48a474b9147b760fd6028af1a3a9df3ab31/beginner-bootstrap/release-passport.json) · [auditable evidence](docs/evidence/auditable-demo/a5807fa19a55a5e454187890de90b48a474b9147b760fd6028af1a3a9df3ab31/beginner-bootstrap/public-evidence.json)

</details>
<!-- buildchain-auditable-demo:end -->

<!-- buildchain:badges:start -->

[![KFD-1: passed](https://buildchain.libkungfu.dev/badges/v1/kfd-1/passed.svg)](https://github.com/kungfu-systems/buildchain/releases/latest/download/buildchain.release.json)
[![KFD-2: passed](https://buildchain.libkungfu.dev/badges/v1/kfd-2/passed.svg)](https://github.com/kungfu-systems/buildchain/releases/latest/download/buildchain.release.json)
[![KFD-3: passed](https://buildchain.libkungfu.dev/badges/v1/kfd-3/passed.svg)](https://github.com/kungfu-systems/buildchain/releases/latest/download/buildchain.release.json)
[![KFD-4: declared](https://buildchain.libkungfu.dev/badges/v1/kfd-4/declared.svg)](https://github.com/kungfu-systems/buildchain/releases/latest/download/buildchain.release.json)
[![Buildchain Release Passport: passed](https://buildchain.libkungfu.dev/badges/v1/buildchain-release-passport/passed.svg)](https://github.com/kungfu-systems/buildchain/releases/latest/download/buildchain.release.json)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-0969da.svg)](https://github.com/kungfu-systems/buildchain/blob/HEAD/LICENSE)
[![Platform: macOS | Linux | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-6e7781.svg)](https://github.com/kungfu-systems/buildchain/releases/latest/download/buildchain.release.json)
[![Verify](https://github.com/kungfu-systems/buildchain/actions/workflows/verify.yml/badge.svg)](https://github.com/kungfu-systems/buildchain/actions/workflows/verify.yml)
[![Buildchain Ref Promotion](https://github.com/kungfu-systems/buildchain/actions/workflows/buildchain-ref-promotion.yml/badge.svg)](https://github.com/kungfu-systems/buildchain/actions/workflows/buildchain-ref-promotion.yml)
[![Binary Distribution](https://github.com/kungfu-systems/buildchain/actions/workflows/binary-distribution.yml/badge.svg)](https://github.com/kungfu-systems/buildchain/actions/workflows/binary-distribution.yml)
<!-- buildchain:badges:end -->

Buildchain Release Passport is a mature product release record for artifacts
that users or agents depend on.

Buildchain by Kungfu uses GitHub as the execution and trust substrate: protected
refs, reviewed promotion PRs, exact tags, GitHub Releases, npm Trusted
Publishing, and machine-readable evidence. Its job is to turn release intent
into an auditable product record, not to ask a repository to migrate away from
its existing CI.

The same mechanism releases Buildchain itself.

## Choose Your Path

| You are... | Start here | You will get... |
| --- | --- | --- |
| adopting Buildchain for the first time | [Golden Path](docs/getting-started.md) | an exact install, project declaration, validated config, reusable workflow, release dry-run, and Passport inspection |
| looking up a CLI command | [Generated CLI Reference](docs/cli-reference.md) | governed syntax, options, aliases, and side-effect-free help paths |
| writing JavaScript automation | [Generated Node API Reference](docs/node-api-reference.md) | every public subpath and symbol with source-derived signatures and behavior boundaries |
| operating an advanced build or release | [Documentation Map](docs/MAP.md) | capability-, intent-, and maturity-based navigation to normative contracts |

The Golden Path is the beginner lane. Advanced workflow, signing, publishing,
and governance manuals remain separate so a first-time consumer does not need
to understand the entire release control plane before reaching a valid local
configuration.

## Where Buildchain sits in the Agent Supply Chain

Buildchain binds a product's declarations to the exact source cut, build,
artifacts, checks, and promotion record that produced a release. In the wider
Agent Supply Chain it sits between KFD-3 product discovery and KFD-2
purpose-bound assessment:

```text
KFD-3 declaration -> Buildchain exact-artifact evidence -> KFD-2 assessment
```

Buildchain can prove that a declared claim and an exact artifact remain
consistent, or fail/downgrade when their evidence drifts. It does not invent
the product fact, decide whether a receiver should trust it for a purpose,
certify every platform, or prove external adoption. Receivers and downstream
KFD-2 assessors retain the admission decision and residual risk.

To evaluate the layer, inspect a release's `buildchain.release.json` and
`artifact-evidence.json`, verify them with the CLI, and report missing product
or protocol evidence through the repository issue tracker.

## Install and Verify

New repository adopters should follow the [15–30 minute Golden Path](docs/getting-started.md).
The commands below are the shorter verification-only route for an existing
consumer.

For v3, use the published npm package and verify the release passport before
trusting release evidence:

```bash
curl -LO https://github.com/kungfu-systems/buildchain/releases/download/v3.0.0/buildchain.release.json
curl -LO https://github.com/kungfu-systems/buildchain/releases/download/v3.0.0/artifact-evidence.json
npx @kungfu-tech/buildchain@3.0.0 verify release-passport buildchain.release.json
npx @kungfu-tech/buildchain@3.0.0 version
```

The v3.0.0 release publishes evidence assets but no standalone platform archives.
The names below describe the optional archive contract used by legacy release
lines:

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

Repositories can also generate README status badges from Buildchain-owned facts
instead of hand-maintaining badge Markdown:

```bash
buildchain badges bundle --check
buildchain badges bundle --write
buildchain badges readme --check
buildchain badges readme --write
```

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
- uses: kungfu-systems/buildchain/actions/report-buildchain-issue@v3
  if: failure()
  with:
    token: ${{ steps.buildchain-issue-token.outputs.token }}
    summary: "Reusable build failed before artifact finalization"
    failure-code: reusable-build-failed
    buildchain-ref: v3
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
npx @kungfu-tech/buildchain release --dry-run --target-ref alpha/v3/v3.0
```

Bootstrap and inspect a governed paper repository through one interface:

```bash
npx @kungfu-tech/buildchain paper scaffold \
  --package @kungfu-tech/paper-example \
  --repository kungfu-systems/paper-example
pnpm add -D @kungfu-tech/buildchain@<exact-v3-version>
pnpm exec buildchain paper work start <topic>
pnpm exec buildchain paper work submit
pnpm exec buildchain paper preflight --offline
pnpm exec buildchain paper status
```

The paper surface is dry-run first. Add `--write` only to create missing
scaffold files. `work start` and `work submit` validate the canonical remote,
exact development SHA, clean source, safe branch, and fast-forward boundary
before changing local or GitHub state. External mutations such as npm
bootstrap, Alpha PR creation, and release resumption require `--execute`. See
[`docs/publication-artifacts.md`](docs/publication-artifacts.md) for the
evidence-state model and operator flow.

Buildchain supports package and non-package projects through
`.buildchain/buildchain.toml`. Legacy root `buildchain.toml` files remain
readable, but new consumers should keep Buildchain-owned files under
`.buildchain/`:

```text
.buildchain/buildchain.toml
.buildchain/contract-lock.json
.buildchain/kfd/kfd-3/surfaces.json
.buildchain/release-passport/buildchain.release.json
```

Lifecycle commands can call pnpm, npm, yarn, pip, Conan, CMake, Make, custom
scripts, or any other command that can run in the repository checkout.

The KFD entrypoint is `buildchain kfd`. Buildchain provides concrete KFD-1
contract-world, KFD-2 trust-claim, and KFD-3 collaboration-surface workflows,
plus fail-closed product-evidence gates for KFD-4, KFD-5, and KFD-7. These
gates preserve product-owned qualification and support decisions; they do not
turn a schema-valid record into certification or shipped support.

Buildchain's action registry currently contains seven active entries. Five are
direct consumer integration actions:

- `actions/validate-config`
- `actions/run-lifecycle`
- `actions/promote-buildchain-ref`
- `actions/report-buildchain-issue`
- `actions/release-tail`

Two additional release-authority components are also registered and versioned:

- `actions/github-artifact-attestation`
- `actions/macos-credential-island`

`dist/site/workflow-registry.json#actions` is the machine-readable inventory;
this split keeps the older four-action consumer snapshot from being mistaken for
the complete current registry.

The active reusable workflow surfaces are:

- `.github/workflows/.gate-profile.yml` for project-neutral Shifu Gate profile
  planning, capability-aware runner dispatch, receipt validation, and one
  stable aggregate check;
- `.github/workflows/.auditable-demo.yml` for exact-artifact demo
  qualification, transcript-bound renderer smoke, optional media rendering
  from the exact passing Gate bundle, and opt-in content-addressed web-delivery
  profiles with independently verified rendition roles;
- `.github/workflows/.declarative-auditable-demo.yml` for standalone binary
  consumers that provide only a versioned multi-demo argv scenario and exact
  same-run binary artifact coordinates; Buildchain owns isolated native
  capture, Gate, Release Passport, materialization, and protected README PRs;
- `.github/workflows/.build.yml` for deterministic multi-platform build and
  artifact contracts;
- `.github/workflows/build.yml` for the single-config channel router that uses
  `vN-alpha` during development/prerelease work and `vN` for stable releases;
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
uses: kungfu-systems/buildchain/actions/validate-config@v3
```

```yaml
uses: kungfu-systems/buildchain/.github/workflows/build.yml@v3
```

```yaml
uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v3
```

## Release Model

Buildchain treats a reviewed branch merge as release intent:

| Merge path                              | Meaning                                                | Exact tag        | Floating refs                                        |
| --------------------------------------- | ------------------------------------------------------ | ---------------- | ---------------------------------------------------- |
| `dev/vX/vX.Y -> alpha/vX/vX.Y`          | publish the next testable alpha for a minor line       | `vX.Y.Z-alpha.N` | `vX.Y-alpha`, `alpha/vX/vX.Y`, `dev/vX/vX.Y`         |
| `alpha/vX/vX.Y -> release/vX/vX.Y`      | publish production for that minor line                 | `vX.Y.Z`         | `vX.Y`, usually `vX`, `release/vX/vX.Y`              |
| `release/vX/vX.Y -> publish-gate/major` | publish the next major from a reviewed production line | `v(X+1).0.0`     | `v(X+1)`, `v(X+1).0`, new dev/alpha/release branches |

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
- [GitHub governance authority](docs/github-governance-authority.md)
- [GitHub-native Linux artifact attestation](docs/github-artifact-attestation.md)
- [Binary distribution details](docs/binary-distribution.md)
- [Toolkit observability](docs/toolkit-observability.md)
- [Site bundle contract](docs/site-bundle-contract.md)
- [Lifecycle protocol](docs/lifecycle-protocol.md)
- [Reusable build surface](docs/reusable-build-surface.md)
- [Shifu Gate profile orchestration](docs/shifu-gate-profiles.md)
- [Release candidate passport](docs/release-candidate.md)
- [Consumer issue reporting](docs/consumer-issue-reporting.md)
- [Publish transaction](docs/publish-transaction.md)
- [Declarative release-tail contract](docs/release-tail-contract.md)
- [Release governance](docs/release-governance.md)
