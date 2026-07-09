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

## Node API and Package Exports

Buildchain's public Node API is the package `exports` surface, not arbitrary
internal file paths. The npm package also ships
`dist/site/node-api-registry.json` and exports it as
`@kungfu-tech/buildchain/site/node-api-registry.json` so agents can enumerate
the supported imports from the installed package.
For navigation, start with `dist/site/capability-registry.json`: it groups
manuals, CLI commands, workflow/action inputs, Node exports, site pages, and KFD
claim facts by product capability before an agent chooses a concrete command or
manual.

Current public import families include:

```js
import * as buildchain from "@kungfu-tech/buildchain";
import { createBuildchainLogger } from "@kungfu-tech/buildchain/logging";
import { collectModuleBuildFacts } from "@kungfu-tech/buildchain/build-facts";
import { checkHomebrewTap } from "@kungfu-tech/buildchain/homebrew";
import { verifyKfd1ReleaseGate } from "@kungfu-tech/buildchain/kfd-gate";
import { collectBadgeBundleFacts } from "@kungfu-tech/buildchain/badges";
import { collectReadmeBadgeFacts } from "@kungfu-tech/buildchain/readme-badges";
import { verifyReleasePassport } from "@kungfu-tech/buildchain/release-passport";
import { createReleasePropagationPlan } from "@kungfu-tech/buildchain/release-propagation";
import { planReleaseLineBootstrap } from "@kungfu-tech/buildchain/release-line-bootstrap";
import { collectPublicSurfaceReverseAudit } from "@kungfu-tech/buildchain/public-surface-audit";
import contractWorld from "@kungfu-tech/buildchain/site/buildchain-contract.json" with { type: "json" };
import capabilityRegistry from "@kungfu-tech/buildchain/site/capability-registry.json" with { type: "json" };
import manualRegistry from "@kungfu-tech/buildchain/site/manual-registry.json" with { type: "json" };
import nodeApiRegistry from "@kungfu-tech/buildchain/site/node-api-registry.json" with { type: "json" };
import publicSurfaceAudit from "@kungfu-tech/buildchain/site/public-surface-audit.json" with { type: "json" };
```

Use `dist/site/manual-registry.json` to find the packaged operating manuals and
their SHA-256 digests. Use `dist/site/buildchain-contract.json` to verify the
floating-ref contract world for a runtime such as `@v2`.

## Commands

`buildchain init` writes a starter `.buildchain/buildchain.toml` and a reusable workflow
caller at `.github/workflows/build.yml`.

Supported presets:

- `--type package` for Node package repositories with pnpm, npm, or yarn.
- `--type native` for CMake-style native projects.
- `--type web-surface` for preview/staging/production site or app deployments.
- `--type infra-contract` for provider-agnostic infrastructure contract
  validation, observation, contract publication, and downstream propagation
  planning without default mutation. Provider adapters expose built-in command
  plans by default, and only configured `[infra.commands]` hooks can execute.
- `--type publication-artifact` for papers, reports, specifications, and other
  publication repositories that produce PDFs, metadata, source bundles, and
  site-consumable manifests without becoming web-surface repositories.
- `--type distribution-index` for Homebrew taps and other index repositories
  whose files are projections of upstream release passport evidence.
- `--type anchored-package` for packages whose version is anchored to an
  explicit upstream release manifest.

The native preset includes an opt-in `[diagnostics.native]` profile with common
tool/cache/artifact probes. Consumers can keep it enabled, adjust the tool and
directory lists, or disable it if a repository does not need native diagnostics.

`buildchain validate` parses `.buildchain/buildchain.toml`, checks configured version-state
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

`buildchain release line open` plans or writes the first version-state commit
for a new semver minor line. It does not publish anything. The dry-run mode is
the default and returns the dev/alpha/release refs, protection contract, default
branch action, and initial version before any GitHub mutation happens:

```bash
buildchain release line open \
  --major 2 \
  --minor 10 \
  --source-ref release/v2/v2.9 \
  --json
```

The write mode only updates local version-state files. The repository workflow
`Release Line Bootstrap` wraps this command and, when `apply=true`, commits the
initial version state, creates `dev/vX/vX.Y`, `alpha/vX/vX.Y`, and
`release/vX/vX.Y`, applies one-review branch protection, switches the default
branch, and opens the first dev-to-alpha channel PR:

```bash
buildchain release line open \
  --major 2 \
  --minor 10 \
  --source-ref release/v2/v2.9 \
  --write \
  --json
```

`buildchain` also publishes a public surface reverse audit as
`dist/site/public-surface-audit.json`. The audit enumerates CLI commands from
`bin/buildchain.mjs`, workflow inputs, action inputs, site pages, and docs
command references, then compares them with the generated registries. Buildchain
self-checks fail closed when an enumerable public surface is missing from the
registry:

```js
import {
  collectPublicSurfaceReverseAudit,
  assertPublicSurfaceReverseAudit,
} from "@kungfu-tech/buildchain/public-surface-audit";

assertPublicSurfaceReverseAudit(collectPublicSurfaceReverseAudit({ root: process.cwd() }));
```

`buildchain kfd` is the product-facing KFD namespace. Schema commands expose the
machine-readable KFD standards shipped by `@kungfu-tech/kfd`, while versioned
subcommands host concrete product workflows. KFD-1, KFD-2, and KFD-3 are
first-class Buildchain surfaces. KFD-4 is schema-only until Buildchain has a
real verification protocol for it.

`status` reports implemented support and the active repo-owned file layout.
`migrate-layout` moves legacy root files into `.buildchain/`:

```bash
buildchain kfd status --json
buildchain kfd migrate-layout --write
```

KFD-1 commands generate and validate contract-world release evidence:

```bash
buildchain kfd 1 schema --json
buildchain kfd 1 witness --json
buildchain kfd 1 gate --witness-json kfd-1-witness.json --json
buildchain kfd 1 verify --gate-json kfd-1-gate.json --json
```

KFD-2 commands validate trust taxonomy entries and generate Buildchain's public
claim evidence:

```bash
buildchain kfd 2 schema --json
buildchain kfd 2 taxonomy --entry-json residual-risk.json --kind residualRisk --json
buildchain kfd 2 claims --json
```

KFD-3 commands are separate from Buildchain's self reverse audit: products can
detect standard public surfaces, register the accepted boundary, audit the
current source or artifact tree, generate a release-passport-compatible witness,
and expose a capability map for agents:

```bash
buildchain kfd schema list --json
buildchain kfd schema show kfd-3 --json
buildchain kfd 3 detect --kind node-api --kind cli --json
buildchain kfd 3 register node-api --product Buildchain
buildchain kfd 3 audit --json
buildchain kfd 3 witness --kind prebuild --output .buildchain/kfd-3/collaboration-interface.prebuild.json
buildchain kfd 3 query buildchain --json
buildchain kfd 4 schema --json
```

The public Node API is exported from `@kungfu-tech/buildchain/kfd`. See
[`kfd-support.md`](kfd-support.md) for the detected / declared / enforced model
and the agent query flow.

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

`buildchain facts` collects and verifies source/version/output facts for
modules and products:

```bash
buildchain facts module \
  --module native-core \
  --output .buildchain/facts/native-core.json \
  --legacy-kungfu-buildinfo framework/core/src/kungfu/yijinjing/kungfubuildinfo.json

buildchain facts aggregate \
  --product kungfu \
  --module-fact .buildchain/facts/native-core.json \
  --artifact dist/kungfu.zip \
  --output .buildchain/facts/kungfu.json

buildchain facts verify --fact .buildchain/facts/kungfu.json
```

The same implementation is available from
`@kungfu-tech/buildchain/build-facts`. Release passports can include these
facts with repeated `--build-facts-json` arguments to
`buildchain collect github-release`. See
[`build-facts.md`](build-facts.md) for the config schema and Node API.

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

It validates `.buildchain/buildchain.toml`, package-manager detection, Git repository state,
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

`buildchain release`, `buildchain web-surface`, `buildchain infra-contract`,
`buildchain publication-artifact`, `buildchain publish-source`,
`buildchain badges`, `buildchain homebrew`, and `buildchain build-contract`
route to the same implementation used by
Buildchain's package APIs or GitHub Actions workflows. This keeps local
inspection and CI behavior on the same implementation path.

Generate publication artifact metadata after building a paper or report:

```bash
buildchain publication-artifact manifest \
  --source-sha "$(git rev-parse HEAD)" \
  --json
```

The command writes `.buildchain/publication/publication-artifact.json`,
`.buildchain/publication/publication-artifact-passport.json`, a source bundle,
and, when `[publication.archive]` is configured,
`.buildchain/publication/publication-registry.json` by default. See
[`publication-artifacts.md`](publication-artifacts.md) for the repository
contract and reusable workflow.

Generate, check, or update the managed README badge block:

```bash
buildchain badges readme --json
buildchain badges readme --check
buildchain badges readme --write
buildchain badges bundle --json
buildchain badges bundle --check
buildchain badges bundle --write
buildchain badges bundle --claims kfd-1,release-passport --write
```

The `--json` form emits the `kungfu-buildchain-readme-badge-facts` object.
`--check` fails closed when the README marker block is missing or stale.
`--write` inserts or replaces only the marked block. KFD passed badges come
from the repository's own verified release passport; unreleased repositories
downgrade to explicit local declarations such as `declared`, `aligned`, or
`planned`. `buildchain badges bundle` is the focused trust-badge entrypoint: it
emits `kungfu-buildchain-badge-bundle-facts` and defaults to KFD-1, KFD-2,
KFD-3, and Release Passport. See [`readme-badges.md`](readme-badges.md) for the
marker contract and `[badges]` / `[badges.bundle]` configuration.

Generate or check Homebrew tap projections from upstream release passports:

```bash
buildchain homebrew update-formula \
  --package buildchain \
  --release-passport https://github.com/kungfu-systems/buildchain/releases/download/v2.8.15/buildchain.release.json \
  --write

buildchain homebrew check --json
```

`update-formula` writes `Formula/buildchain.rb` and `tap-manifest.json` from
upstream release passport evidence. `check` fails closed when the Formula,
manifest, artifact digests, or KFD status drift from the upstream passport. See
[`homebrew.md`](homebrew.md) for the distribution-index project contract.

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

For publish-transaction releases, pass the additional evidence inputs so
`buildchain.release.json` becomes the unified passport instead of a binary-only
asset summary:

```bash
buildchain collect github-release \
  --tag v2.3.2 \
  --repository kungfu-systems/buildchain \
  --assets-dir dist \
  --publish-evidence-json .buildchain/release-evidence/v2.3.2/evidence.json \
  --transaction-json .buildchain/release-state/v2.3.2/state.json \
  --package-set-json package-set.json \
  --impact-json impact.json \
  --trusted-publishing-json trusted-publishing.json \
  --anchor-manifest-json libnode.release.json \
  --build-summary-json .buildchain/artifacts/build-summary.json \
  --platform-manifest-json .buildchain/artifacts/linux-x64/manifest.json \
  --platform-manifest-json .buildchain/artifacts/darwin-arm64/manifest.json \
  --platform-manifest-json .buildchain/artifacts/win32-x64/manifest.json \
  --dist-tag-evidence-json .buildchain/release-evidence/v2.3.2/dist-tag-evidence.json \
  --kfd-1-witness-json .buildchain/kfd-1/contract-world.witness.json \
  --kfd-2-claim-json .buildchain/kfd-2/release-claims.json \
  --kfd-3-prebuild-witness-json .buildchain/kfd-3/collaboration-interface.prebuild.json \
  --kfd-3-artifact-verify-cmd "kungfu agent verify --json" \
  --release-extra-json '{"channel":"release","targetRef":"release/v2/v2.3"}' \
  --output-dir .buildchain/release-passport
```

The generated passport records the main and platform packages, npm dist-tags,
published versions, release source/ref state, anchor manifest digest, registry
artifact digests, trusted publishing evidence, and Buildchain transaction
result. It also records `buildSummary`, `platformArtifactManifests`, and
`distTagPromotion` when those JSON inputs are supplied. `packageSet` keeps the
ordered package set; `publish.packages[]` is the agent-readable npm publication
summary for each main/platform package. For Buildchain releases, verification
expects the supplied package set to include the main package plus the three
platform packages with version, dist-tag, and digest evidence. Verification
fails closed if supplied sections are internally incomplete or point to
artifacts without matching evidence.

`--kfd-1-witness-json` attaches a KFD-1 contract-world release gate. The witness
is structured JSON: consumers declare the contract world, canonical JSON policy,
artifact paths, and expected SHA-256 digests. Buildchain imports KFD-owned
metadata from `@kungfu-tech/kfd`, freezes the witness before build publication,
then verifies the resulting artifact bytes itself and writes the evidence under
the KFD-provided top-level key currently named `kfd-1`. Consumers should not
duplicate this by running repository-specific scripts or invoking the Kungfu
SDK from their release workflow.

For the KFD repository, KFD-1 witnesses may be self-hosted standard-contract
witnesses: docs, schemas, standards metadata, package exports, and
site-consumption entrypoints are checked from source hashes to packaged artifact
hashes, and the passport records schema IDs, self-hosting boundary, result, and
responsibility state.

`--kfd-2-claim-json` attaches explicit public release claims to the KFD-2
release trust passport audit. Buildchain also derives KFD-2 claims from KFD-1
and KFD-3 gate evidence. Public claims must bind declared sources,
machine-readable evidence, hashes, artifact coordinates, verification results,
audit boundary, responsibility state, and residual risk. Unbound claims fail
passport verification; prose-only claims downgrade the KFD-2 audit and emit a
warning.

`--kfd-3-prebuild-witness-json` attaches a KFD-3 collaboration-interface
release gate. The product remains the source of truth: it emits a pre-build
witness that contains or points to its KFD-3 collaboration interface, declared
participant-facing public surfaces, and registry digest. Buildchain freezes
that declaration before publication. The artifact side is supplied either by
`--kfd-3-artifact-witness-json` or by a product-owned command such as
`--kfd-3-artifact-verify-cmd "kungfu agent verify --json"`. Buildchain then
checks closure: every declared shipped public surface must be present in the
artifact witness, and every artifact-exposed participant-facing public surface
must have been declared. The generated passport writes this evidence under the
KFD-provided top-level key currently named `kfd-3`.

This gate is useful for agent-facing products because it turns KFD-3 from prose
into release evidence. A package cannot claim KFD-3 collaboration-interface
support merely because the docs mention it; the release passport must show the
frozen declaration, the artifact-side witness digest, and a passing closure
comparison.
For the KFD repository itself, the witness can declare docs, schemas, standards
metadata, package exports, and site-consumption contracts as grouped public
surfaces; the artifact witness must expose the same enumerable package/site
surfaces or verification fails closed.

`--impact-json` supplies the surface-aware impact ledger. Production release
passports (`release/*`) and major publish-gate passports require
`surfaceImpacts[]`; alpha, local, and legacy passport contexts keep it
optional. When `surfaceImpacts[]` is required or supplied, the verifier requires
each entry to include an id, impact, and rationale, and requires
`versionImpact.final` to match the highest declared surface impact. The
collector copies `versionImpact` plus `surfaceImpacts` into
`buildchain.release.json`. This lets
`buildchain explain release --for agent --json` state why a release is patch,
minor, or major instead of relying on file-path memory.

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

Verify a published artifact by subject:

```bash
buildchain verify artifact ./Kungfu-2.8.0-windows-x64.exe
buildchain inspect artifact ./Kungfu-2.8.0-windows-x64.exe --json
buildchain explain artifact ./Kungfu-2.8.0-windows-x64.exe --for agent --json
```

`verify artifact` computes or obtains the subject digest, discovers the
detached release passport, verifies the passport, then requires that the
subject digest appears in the passport's release assets, package set, publish
evidence, or artifact evidence. Outcomes are explicit: `pass`, `fail`, or
`unverifiable`. A filename is only a hint; trust comes from digest equality.

Discovery is fail-closed and ordered:

1. `--passport <file-or-url>`.
2. Sidecar pointer, such as `<artifact>.buildchain-passport.json`.
3. Embedded/package pointer, such as `package.json` `buildchain.releasePassport`.
4. Local config or org index, such as `.buildchain/artifact-passport-locators.json`.
5. GitHub Release default discovery from `github-release:` subjects, GitHub
   Release asset URLs, or `--repository <owner/repo> --tag <tag>`.
6. Custom `--locator-config <json-or-url>`.
7. `unverifiable` with retry guidance.

Locator files are policy, not protocol. They map subject fields such as
`name`, `kind`, `version`, `digest`, `repository`, or `tag` to a detached
passport location:

```json
{
  "schemaVersion": 1,
  "contract": "kungfu-buildchain-artifact-passport-locator",
  "locators": [
    {
      "match": {
        "name": "Kungfu-2.8.0-windows-x64.exe",
        "digest": "sha256:..."
      },
      "passport": "../release-passport/buildchain.release.json"
    }
  ]
}
```

Supported subject shapes include local files and directories, URLs,
`npm:<name>@<version>`, `oci:...`, `s3:...`,
`github-release:<owner/repo>@<tag>/<asset>`, and deployment endpoints. Local
files, directories, and URLs are digestable directly; remote package, OCI,
object storage, and deployment subjects should provide a digest or resolve to a
locator that records one.

Verify infra-contract lifecycle evidence bundles:

```bash
buildchain infra-contract --mode ci --source-sha "$GITHUB_SHA"
buildchain verify infra-contract-evidence-bundle .buildchain/infra-contract-evidence-bundle.json
```

The infra-contract `ci` mode is mutation-free. It writes validate, plan,
contract, propagation dry-run, evidence bundle, and verification JSON artifacts
under `.buildchain/`, giving reusable workflows one standard responsibility
chain instead of hand-written command sequences.

The infra-contract verifier is read-only. It recomputes the bundle hash and
checks that desired, plan, approval, apply, observe, contract, and propagate
evidence remain bound to the same contract artifact. It also recomputes the
bundle validation summary, so stale or misleading summary booleans fail closed
even when the bundle hash has been refreshed.

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
It runs on a GitHub-hosted runner with `id-token: write`, but it does not
manually run the release-candidate resolver or promote action. Buildchain's own
dogfood path calls the declarative `release-candidate-promote.yml` wrapper with
channel, target ref/SHA, PR-stage workflow, artifact, status-check, and passport
inputs. The wrapper generates the version-state commit, runs
`lifecycle.verify`, runs `lifecycle.publish`, writes Buildchain publish
evidence, validates that evidence, and only then moves exact tags and floating
refs.

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
