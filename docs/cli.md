# Buildchain CLI, npm Package, and Toolkit API

Buildchain is published as the public npm package
`@kungfu-tech/buildchain`. The package contains the `buildchain` command,
the importable ESM toolkit APIs, and the local scripts needed to initialize and
validate repositories before they use the reusable GitHub workflow surface.

The npm package is not the release authority. Release authority still comes
from the protected Buildchain branch and tag state machine. npm publishing is a
side effect of an exact release tag that has already been produced by that
state machine.

## Install and Run

Use the published package directly:

```bash
npx @kungfu-tech/buildchain --help
npx @kungfu-tech/buildchain init --type package
npx @kungfu-tech/buildchain validate --require-version-state
```

Or install it in a repository:

```bash
pnpm add -D @kungfu-tech/buildchain
pnpm exec buildchain validate
```

Consumers should pin the exact Buildchain version that was validated in their
repository. When dogfooding a fresh Buildchain release immediately after it is
published, pnpm may block the install through a minimum release-age policy. In
that case, add a temporary package/version-specific `minimumReleaseAgeExclude`
entry, such as `@kungfu-tech/buildchain@2.2.5`, and remove it once the package
has aged past the normal policy window. Do not replace that with a broad
registry or scope-wide exclude.

Use the package API directly inside JavaScript build scripts:

```js
import { createBuildchainLogger } from "@kungfu-tech/buildchain/logging";

const logger = createBuildchainLogger({ source: "user", component: "build" });
await logger.span("build.native", { phase: "build" }, async () => {
  await buildNativeArtifacts();
});
```

The standalone binary and CLI are for workflow steps, shell scripts, and
non-JavaScript environments. JavaScript code that already depends on
`@kungfu-tech/buildchain` should import the toolkit API instead of spawning
`npx buildchain` or a downloaded binary.

## Commands

`buildchain init` writes a starter `buildchain.toml` and a reusable workflow
caller at `.github/workflows/build.yml`.

Supported presets:

- `--type package` for Node package repositories with pnpm, npm, or yarn.
- `--type native` for CMake-style native projects.
- `--type web-surface` for preview/staging/production site or app deployments.
- `--type anchored-package` for packages whose version is anchored to an
  explicit upstream release manifest.

The native preset includes an opt-in `[diagnostics.native]` profile with common
tool/cache/artifact probes. Consumers can keep it enabled, adjust the tool and
directory lists, or disable it if a repository does not need native diagnostics.

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

Lifecycle runs also write a Buildchain observability JSONL log at
`.buildchain/logs/events.jsonl` by default. Framework events use
`source=buildchain`; consumer lifecycle commands use `source=user`. This lets a
maintainer tell apart time spent inside Buildchain's artifact/manifest
framework from time spent in the repository's own build, test, packaging, or
publish commands. The artifact manifest and summary embed the observability
summary for that lifecycle run id, so uploaded artifacts preserve the timing
facts without mixing in older JSONL events.

`buildchain log`, `buildchain mark`, and `buildchain span` expose the same event
protocol to repository scripts:

```bash
buildchain mark --event configure.ready --phase configure --attribute target=release
buildchain span --event native.build --phase build -- cmake --build build
buildchain log warn --event cache.miss --component conan --attribute token=hidden
buildchain log summary --json
buildchain verify observability-log .buildchain/logs/events.jsonl --min-events 4 --require-phase build
buildchain diagnostics summary .buildchain/artifacts/*/diagnostics.json --json
buildchain sample process-tree --label native-build --interval-ms 15000 -- make -j20
```

During `buildchain lifecycle run`, child processes receive
`BUILDCHAIN_LOG_PATH` and `BUILDCHAIN_LOG_RUN_ID`. A shell, Python, CMake, Conan,
or JavaScript helper can call `buildchain mark` or `buildchain span` mid-build
and have those events grouped into the same lifecycle summary.
`buildchain verify observability-log` is a release gate: it fails when the log
is missing, has too few events, contains error events, or does not include
required phases, components, or event names.

The event protocol is JSONL and is also available from the SDK:

```js
import { createBuildchainLogger } from "@kungfu-tech/buildchain/logging";

const logger = createBuildchainLogger({ source: "user", component: "native-build" });
logger.mark("configure.ready", { phase: "configure" });
```

Secret-looking attribute keys such as `token`, `password`, `secret`,
`authorization`, `cookie`, and `private-key` are redacted before they are written.
Full command strings are not recorded by `span`; scripts should provide stable
event names and safe attributes instead.

`buildchain diagnostics summary` reads one or more small diagnostics artifacts
and emits the same cross-platform summary as the diagnostics SDK:

```bash
buildchain diagnostics summary \
  .buildchain/artifacts/linux-x64/diagnostics.json \
  .buildchain/artifacts/macos-arm64/diagnostics.json \
  --output .buildchain/artifacts/diagnostics-summary.json \
  --json
```

The JSON summary keeps per-platform lifecycle stage tables, adds lifecycle
total durations, carries top slow spans, aggregates warning/error counts, and
sorts the slowest platforms. Each platform row carries compact runner facts,
checked tool versions/missing tools, package manager/cache directory details,
compiler-cache availability, and a compact process sampler summary: requested
parallelism, observed max active processes, the ratio between them, sample
count, process categories, and the top sampled command basenames. This lets
maintainers inspect matrix timing, runner, tool, cache, and concurrency context
without downloading large platform binaries or process sidecars first.
When a sibling `diagnostics-manifest.json` is available, the summary also records
its file list and verifies the listed `diagnostics.json` byte count and sha256.
Missing, unreadable, or mismatched sidecar manifests are reported through
`diagnosticsManifestWarningCount` and the per-platform `diagnosticsManifest`
field without failing the timing rollup.
The summary also compares each `diagnostics.json` contract to
`BUILDCHAIN_DIAGNOSTICS_CONTRACT`; mismatches are reported through
`diagnosticsContractWarningCount` and the per-platform `diagnosticsContract`
field so reviewers can separate diagnostics schema drift from lifecycle
warnings or build failures.

Without `--json`, the command prints a compact lifecycle timing table with
install/build/verify/publish, artifact scan/upload, total, warning, and error
columns for each platform, plus `jobs` and `active` columns for requested and
observed process concurrency when sampler data is present.

`buildchain sample process-tree` wraps a long-running command and periodically
writes process-tree snapshots:

```bash
buildchain sample process-tree \
  --label native-build \
  --interval-ms 15000 \
  --output .buildchain/diagnostics/process-samples.jsonl \
  --summary-output .buildchain/diagnostics/process-summary.json \
  -- \
  make -j20
```

The command returns the wrapped command's exit status. The JSONL file contains
small timestamped samples; the summary JSON records requested parallelism,
observed concurrency, sampled CPU, command categories, and top command
basenames. Use it when a native build requests high parallelism but appears to
spend long stretches in low-concurrency compile, archive, link, or cache steps.

`buildchain doctor` checks repository readiness before remote side effects:

```bash
buildchain doctor --json
```

It validates `buildchain.toml`, package-manager detection, Git repository state,
and the reusable workflow caller. For `version.strategy = "anchored"` with
`version.next = "manual"`, it also embeds the anchored package release contract
check: anchor manifest readability, configured version files, trusted
publishing, package publish order, and required lifecycle stages. Add
`--require-publish-source-lock` inside a publish job when the doctor report
should also fail unless the job is running from a resolved `publish-gate/*`
source lock.

Anchored/manual package publish jobs can run the narrower source-lock gate
directly:

```bash
buildchain publish-source validate-anchored-release --json
```

The command requires `BUILDCHAIN_PUBLISH_SOURCE_REF`,
`BUILDCHAIN_PUBLISH_SOURCE_SHA`, and `BUILDCHAIN_PUBLISH_SOURCE_LOCKED` from the
reusable build workflow outputs. It fails closed for direct `alpha/*` or
`release/*` channel-branch publication, and checks the publish-gate consumer
version against configured version files and the anchor manifest. The JSON
result is shaped for future `buildchain.libkungfu.dev` fact ingestion.

`buildchain release`, `buildchain web-surface`, `buildchain publish-source`,
and `buildchain build-contract` route to the same scripts used by Buildchain's
GitHub Actions workflows. This keeps local inspection and CI behavior on the
same implementation path.

`buildchain collect github-release` creates a release passport bundle from
GitHub Release assets or a local asset directory:

```bash
buildchain collect github-release \
  --tag v2.2.0 \
  --repository kungfu-systems/buildchain \
  --assets-dir dist \
  --output-dir .buildchain/release-passport
```

The bundle includes `buildchain.release.json`, `artifact-evidence.json`,
`impact.json`, `agent-index.json`, `product-mechanism.json`, `check-report.json`,
and `llms.txt`. Production binary distribution defaults to GitHub-hosted
runners so other projects can reproduce the release lane; self-hosted runners
remain compatibility fixtures and are recorded as runner facts when used.

Buildchain dogfoods its observability toolkit in this lane. The standalone
builder writes API-generated events, while the workflow uses `buildchain mark`,
`buildchain span`, `buildchain verify observability-log`, and `buildchain log
summary`; the event logs and summaries are published as release passport assets.

Verify and explain release passports:

```bash
buildchain verify release-passport .buildchain/release-passport/buildchain.release.json
buildchain explain release --passport .buildchain/release-passport/buildchain.release.json --for agent --json
buildchain inspect release --passport .buildchain/release-passport/buildchain.release.json
```

The verifier fails closed when required protocol files are absent, artifacts are
not covered by evidence, or digests disagree. The explanation output is shaped
for agents: trust, completeness, impact, recovery route, and next action.

`buildchain release --dry-run` explains the release-line state machine before a
maintainer opens or merges a channel PR:

```bash
buildchain release --dry-run --target-ref alpha/v2/v2.2
buildchain release --dry-run --target-ref release/v2/v2.2 --sha <verified-sha>
buildchain release dry-run --target-ref publish-gate/major --source-ref release/v2/v2.2
buildchain release explain --target-ref alpha/v2/v2.1 --json
```

This is a Buildchain-level dry-run, not an npm dry-run. It explains the legal
source branch, exact release or alpha tags, floating tags, channel branches,
version-state files, governance checks, and publish transaction behavior that
would apply if the corresponding PR merge were promoted. It does not move
branches, move tags, edit files, publish npm packages, or run lifecycle publish
commands. `release explain` is the same explanation surface with a clearer name.
Pass `--json` for a machine-readable plan.

`buildchain transaction inspect` is the top-level recovery inspection command
for the publish transaction state:

```bash
buildchain transaction inspect --version v2.1.0-alpha.0
```

It reads or locally initializes the durable transaction record and validates
available publish evidence. Remote durable refs and public Git ref finalization
remain owned by `actions/promote-buildchain-ref`; the CLI inspection surface is
for preflight and recovery reasoning before a maintainer reruns or resumes a
promotion.

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

- package: `@kungfu-tech/buildchain`
- repository: `kungfu-systems/buildchain`
- workflow: `.github/workflows/buildchain-ref-promotion.yml`

No npm package is published by manual dispatch or ordinary branch builds.
Manual dispatch on `.github/workflows/npm-publish.yml` remains dry-run only, so
maintainers can verify package contents and npm publish shape before opening or
merging the release PR.
