---
status: active
period: ongoing
theme: buildchain-cli
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-07-31
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-31
  invisible_context: not asserted
---

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
entry, such as `@kungfu-tech/buildchain@3.0.0`, and remove it once the package
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
import { verifyGitHubArtifactAttestationEvidence } from "@kungfu-tech/buildchain/github-artifact-attestation";
import { createReleasePropagationPlan } from "@kungfu-tech/buildchain/release-propagation";
import { verifyPublicationReproducibility } from "@kungfu-tech/buildchain/publication-reproducibility";
import { collectPaperStatus } from "@kungfu-tech/buildchain/paper";
import { planReleaseLineBootstrap } from "@kungfu-tech/buildchain/release-line-bootstrap";
import { collectPublicSurfaceReverseAudit } from "@kungfu-tech/buildchain/public-surface-audit";
import { createBuildchainLayoutDiscovery } from "@kungfu-tech/buildchain/buildchain-layout";
import { createPortableDevCachePlan } from "@kungfu-tech/buildchain/portable-dev-cache";
import contractWorld from "@kungfu-tech/buildchain/site/buildchain-contract.json" with { type: "json" };
import capabilityRegistry from "@kungfu-tech/buildchain/site/capability-registry.json" with { type: "json" };
import manualRegistry from "@kungfu-tech/buildchain/site/manual-registry.json" with { type: "json" };
import nodeApiRegistry from "@kungfu-tech/buildchain/site/node-api-registry.json" with { type: "json" };
import publicSurfaceAudit from "@kungfu-tech/buildchain/site/public-surface-audit.json" with { type: "json" };
```

Use `dist/site/manual-registry.json` to find the packaged operating manuals and
their SHA-256 digests. Use `dist/site/buildchain-contract.json` to verify the
floating-ref contract world for a runtime such as `@v3`.

For exhaustive lookup, use the generated references rather than scanning this
conceptual guide:

- [`cli-reference.md`](cli-reference.md) is projected from the governed usage
  model and runtime command registry. `buildchain <path> --help` is intercepted
  before dispatch at every listed path, exits zero, and has no command side
  effects.
- [`node-api-reference.md`](node-api-reference.md) is projected from
  `package.json#exports` and exact ESM export declarations. The packaged
  `dist/site/node-api-registry.json` carries the same per-symbol signatures,
  parameters, conservative return/error boundaries, side-effect classification,
  maturity, example import, and source location.

## Commands

`buildchain create github-artifact-attestation-policy` seals the expected
artifact, caller source, original Linux build, immutable Buildchain signer, and
GitHub permission set before the Release Passport is collected.
`buildchain verify github-artifact-attestation` invokes `gh attestation verify`
with the exact signer/source policy and then verifies the retained bundle,
predicate, platform manifest, Passport, and Buildchain evidence locally. See
[`github-artifact-attestation.md`](github-artifact-attestation.md).

### Governed paper lifecycle

`buildchain paper` is the unified operator surface for one paper repository or
a discovered fleet. Every subcommand returns a versioned JSON contract with
`--json`:

```bash
buildchain paper scaffold --package @kungfu-tech/paper-example \
  --repository kungfu-systems/paper-example
buildchain paper migrate --json
buildchain paper agent verify --json
buildchain paper work start golden-path --json
buildchain paper work submit --json
buildchain paper fleet audit --root ../papers --json
buildchain paper fleet update --root ../paper-worktrees --json
buildchain paper preflight --offline --json
buildchain paper bootstrap npm --json
buildchain paper build --json
buildchain paper alpha --json
buildchain paper status --json
buildchain paper resume --json
```

The safety and authority boundary is explicit:

- `scaffold` plans a 17-file, no-overwrite repository shape by default; add
  `--write` to create only missing files.
- `migrate` plans the Buildchain-owned authority, workflow, contract lock,
  version pin, package, agent-entry policy, managed `AGENTS.md` section, and
  required-check changes needed by an existing paper repository. It pins an
  exact v3 dependency and adds pnpm-backed paper scripts.
  Add `--write` only after reviewing exact old and new digests; paper content
  and publication configuration are never rewritten. Refresh
  `pnpm-lock.yaml` with `pnpm install --lockfile-only` after a write.
- `agent verify` is the mandatory resume check on an existing work branch. It
  verifies the digest-bound `.buildchain/paper/agent-entry.json`, the single
  managed `AGENTS.md` section, exact package scripts and v3 dependency, runtime
  source SHA, development target, and current branch lineage. `--ci` derives
  the pull-request source and target from GitHub context and fails closed on a
  non-work source branch or a target other than the configured development
  line.
- `work start` derives the protected development branch from the configured
  publication semver line and creates a safe local work branch only when the
  worktree is clean, the sole `origin` is the canonical `kungfu-systems`
  repository, and local HEAD equals the exact remotely observed development
  SHA. It never fetches or merges silently.
- `work submit` accepts only an allowed non-protected work branch that contains
  the exact remote development commit. It rejects divergent remote work,
  wrong-base pull requests, dirty trees, forks, and ambiguous remotes; execution
  uses a normal non-force push and opens or reuses a PR to the derived
  development branch.
- `fleet audit` discovers `paper-*` repositories from a root and emits one
  deterministic audit root over exact runtime, dependency, lockfile, workflow,
  authority, and repository observations. `fleet update` reuses the migration
  contract for every discovered repository, remains dry-run by default, and
  refuses protected or non-work branches.
- The scaffolded `.buildchain/paper/provisioning-authority.json` binds both
  build/release caller workflow byte digests, the required verify caller, the
  agent-entry policy and instructions, their exact reusable-workflow SHA, the
  runtime SHA, contract-lock bytes, npm registry and trusted-publisher
  coordinates, and the repository Actions/generated-write policy under one
  digest. A floating Buildchain ref cannot change release policy after that
  authority is accepted.
- The reusable `check.yml` detects publication-artifact repositories and runs
  `paper preflight --offline --ci` inside the existing required check context.
  Skipping the local CLI therefore cannot admit a missing entry contract,
  drifted Buildchain-owned surface, unsafe source branch, or wrong PR target.
- `preflight` separates local readiness from readiness for external mutation.
  `--offline` skips live GitHub and npm observations without treating them as
  local failures. Live readiness requires default workflow permissions `read`,
  Actions pull-request approval disabled, and GitHub App or equivalent narrow
  generated-write credential metadata.
- `bootstrap npm` always performs npm pack and publish dry-runs first. A real
  public bootstrap requires both `--execute` and
  `--confirm-public-package <exact-name>`, uses only the official npm registry,
  fixes the bootstrap version at `0.0.0-bootstrap.0`, and returns only npm URLs
  observed from command output. Success requires public package readback and
  the exact repository/workflow/environment trusted-publisher binding. For
  GitHub, the npm coordinate is the workflow filename (`paper-release.yml`),
  not its `.github/workflows/` repository path.
- `build` plans the two-clean-build reproducibility proof. Add `--execute` to
  create and verify the sealed publication bundle.
- `alpha` plans or opens the protected Alpha pull request; it never merges,
  publishes, or advances a floating ref.
- `status` reports only evidence found in the repository or external
  observations. It never infers a later lifecycle state from an earlier one.
- `resume` plans or dispatches the repository's thin release workflow; the
  protected workflow remains the release authority.

The ordered evidence states are `scaffolded`, `governed`, `admitted`,
`bootstrapped`, `trust-bound`, `content-ready`, `artifact-sealed`,
`package-published`, `alpha-complete`, `staging-visible`, and
`production-visible`. A state can be `satisfied`, `not-reached`, `blocked`, or
`unknown`; consumers must not collapse those distinctions.

The corresponding Node surface is
`@kungfu-tech/buildchain/paper`. Planning and status functions are read-only;
`writePaperScaffold()`, `writePaperMigration()`, and
`writePaperFleetUpdate()` are the bounded local writers. Work plans expose
separate rechecking executors for local branch creation and normal push, and
`executePaperNpmBootstrap()` preserves the same confirmation boundary used by
the CLI.

`buildchain layout` is the stable machine question for repository layout. Tools
such as Shifu should call it instead of copying `.buildchain/` path constants:

```bash
buildchain layout --cwd /path/to/repository --json
```

The result identifies the Buildchain version pin, repository root and config,
the canonical and currently resolved KFD-3 registry paths, and the KFD field
used to declare Shifu jurisdiction. A repository is in Shifu's distribution
jurisdiction only when a KFD-3 surface explicitly declares
`distribution.registrar="shifu"`; the presence of Buildchain configuration is
not sufficient. The same contract is available through
`createBuildchainLayoutDiscovery()` from
`@kungfu-tech/buildchain/buildchain-layout`.

`buildchain init` writes a starter `.buildchain/buildchain.toml` and a reusable workflow
caller at `.github/workflows/build.yml`.

`buildchain portable-cache plan` turns a consumer-owned, secret-free manifest
into GitHub Actions cache inputs without letting each consumer invent key or
restore-prefix semantics. The exact key binds source SHA and the consumer plan
digest; the compatible restore prefix still requires the same provider schema,
layer, roots, runner image, platform/architecture, toolchain, dependency lock,
and build profile.

```bash
buildchain portable-cache plan \
  --manifest .buildchain/portable-cache.json \
  --output .buildchain/portable-cache-plan.json \
  --github-output "$GITHUB_OUTPUT"
```

The emitted `cache-key`, `restore-keys`, and `cache-paths` values are intended
for pinned `actions/cache/restore` and `actions/cache/save` actions. After
restore and a consumer validation probe, seal the provider result:

```bash
buildchain portable-cache receipt \
  --plan .buildchain/portable-cache-plan.json \
  --matched-key "$CACHE_MATCHED_KEY" \
  --cache-hit "$CACHE_HIT" \
  --validation-status pass \
  --cold-fallback-status passed \
  --output .buildchain/portable-cache-receipt.json
```

The receipt distinguishes `exact`, `compatible`, `miss`, and `corrupt`.
Unknown or contradictory provider evidence fails closed. A miss or corruption
requires the consumer's audited cold path; a cache never substitutes for the
consumer's current build or tests. Roots must be workspace-relative or under
`~/`, and manifests cannot carry credentials, absolute host paths, or escape
segments. `cold-fallback-status=passed` qualifies a miss only after the current
source has completed its normal build and test path.

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
  site-consumable manifests without becoming web-surface repositories. The
  scaffold uses Buildchain's pinned
  `ghcr.io/kungfu-systems/build-images/latex-pdf-builder:v1.2.0` toolchain for
  LaTeX PDF builds.
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

`buildchain dev merge-queue` plans a GitHub merge-queue policy for a protected
Buildchain dev channel. Declare every workflow that emits a required check; the
command fails closed unless each file handles both `pull_request` and
`merge_group` without reading `github.event.pull_request` directly:

```bash
buildchain dev merge-queue \
  --repository kungfu-systems/example \
  --branch dev/v4/v4.0 \
  --workflow .github/workflows/source-acceptance.yml \
  --workflow .github/workflows/affected-native-pr.yml
```

The default output is a read-only plan. Add `--apply` only after reviewing it.
Apply creates the exact-branch merge-queue ruleset before changing classic
required status checks from strict to loose, preserves the required check
identities, and is safe to repeat. `gh` must be authenticated with repository
Administration write permission for apply mode.

Repositories can make that policy declarative in `buildchain.toml`:

```toml
[governance.dev.merge_queue]
mode = "enabled" # enabled, inherit, or disabled
required_workflows = [".github/workflows/verify.yml"]
check_response_timeout_minutes = 120
max_entries_to_build = 1
bypass_users = ["release-owner"]
```

Use `buildchain dev merge-queue --from-config` to resolve and reconcile the
declaration. `enabled` requires an exact queue on the target dev branch;
`disabled` suppresses automatic queue creation; `inherit` copies the active
default dev branch's queue parameters and bypass actors. When the table is
absent, release-line bootstrap uses the backward-compatible `inherit` mode.
Every inherited or explicitly enabled queue still validates each declared
required workflow before any mutation. For a legacy repository with no table,
an already-active exact queue on the current default dev branch is accepted as
the inheritance evidence; new declarations should list the workflows so future
changes are revalidated from source.
The `Dev Merge Queue Governance` workflow runs this reconciliation after
governance-relevant changes land on a dev branch; its manual dispatch remains
dry-run by default.

`buildchain release line open` plans or writes the first version-state commit
for a new semver minor line. It does not publish anything. The dry-run mode is
the default and returns the dev/alpha/release refs, protection contract, default
branch action, and initial version before any GitHub mutation happens:

```bash
buildchain release line open \
  --major 3 \
  --minor 1 \
  --source-ref release/v3/v3.0 \
  --json
```

The write mode only updates local version-state files. The repository workflow
`Release Line Bootstrap` wraps this command and, when `apply=true`, commits the
initial version state, creates `dev/vX/vX.Y`, `alpha/vX/vX.Y`, and
`release/vX/vX.Y`, applies one-review branch protection, reconciles declared or
inherited merge-queue governance, switches the default branch only after that
reconciliation succeeds, and opens the first dev-to-alpha channel PR:

```bash
buildchain release line open \
  --major 3 \
  --minor 1 \
  --source-ref release/v3/v3.0 \
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

assertPublicSurfaceReverseAudit(
  collectPublicSurfaceReverseAudit({ root: process.cwd() }),
);
```

`buildchain kfd` is the product-facing KFD namespace. Schema commands expose the
machine-readable KFD standards shipped by `@kungfu-tech/kfd`, while versioned
subcommands host concrete product workflows. KFD-1, KFD-2, and KFD-3 are
first-class Buildchain surfaces. KFD-4, KFD-5, and KFD-7 expose fail-closed
product-evidence gate and verification protocols; passing those protocols does
not itself qualify, certify, activate, or ship support.

`status` reports implemented support and the active repo-owned file layout.
`migrate-layout` moves legacy root files into `.buildchain/`:

```bash
buildchain kfd status --json
buildchain kfd migrate-layout --write
buildchain kfd 4 gate --input-json kfd-4-gate-input.json --output kfd-4-gate.json
buildchain kfd 5 gate --input-json kfd-5-gate-input.json --output kfd-5-gate.json
buildchain kfd 7 gate --input-json kfd-7-gate-input.json --output kfd-7-gate.json
buildchain kfd support project --matrix-json support-matrix.json \
  --gate-json kfd-4-gate.json --gate-json kfd-5-gate.json \
  --gate-json kfd-7-gate.json --output kfd-support.json
```

KFD-1 commands generate and validate contract-world release evidence:

```bash
buildchain kfd 1 schema --json
buildchain kfd 1 witness --json
buildchain kfd 1 gate --witness-json kfd-1-witness.json --json
buildchain kfd 1 verify --gate-json kfd-1-gate.json --json
```

KFD-2 commands validate trust taxonomy entries and generate Buildchain's public
claim evidence. Product repositories use the `product-claims` subcommand to
validate and render their own declared KFD-2 release claims under the canonical
Buildchain KFD layout:

```bash
buildchain kfd 2 schema --json
buildchain kfd 2 taxonomy --entry-json residual-risk.json --kind residualRisk --json
buildchain kfd 2 claims --json
buildchain kfd 2 product-claims check --json
buildchain kfd 2 product-claims write --json
buildchain kfd 2 product-claims render --json
```

The default source is `.buildchain/kfd/kfd-2/registry.json`; outputs are
`.buildchain/kfd/kfd-2/release-claims.json`, per-claim release-passport inputs
under `claims/`, and `buildchain-claim-args.txt`. Use `--registry` or
`--output-dir` only for an explicit product packaging projection. `check` never
writes and exits non-zero when outputs drift.

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
buildchain kfd 3 witness --kind prebuild --output .buildchain/kfd/kfd-3/collaboration-interface.prebuild.json
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

The JSON summary also includes an additive `controlPlane` block. It counts
workflow-friction incident outcomes and production release-intent outcomes,
including incident reuse rate, release-intent suppression rate, and suppression
reasons. Buildchain writes those outcome events locally; it does not send
telemetry outside the runner.

The event protocol is JSONL and is also available from the SDK:

```js
import { createBuildchainLogger } from "@kungfu-tech/buildchain/logging";

const logger = createBuildchainLogger({
  source: "user",
  component: "native-build",
});
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

Run the fail-closed clean-room gate before Alpha or release admission:

```bash
buildchain publication-artifact reproducibility \
  --source-sha "$(git rev-parse HEAD)" \
  --promote \
  --json
```

The command checks two independent clones of the exact commit, isolates caches,
derives `SOURCE_DATE_EPOCH` from Git, and compares every declared artifact,
source bundle, publication evidence file, npm package file, and actual npm
tarball. It writes
`.buildchain/publication/reproducibility-receipt.json`. Only a byte-identical
build using the digest-pinned `latex-docker` toolchain is qualifying.
`--allow-unpinned-toolchain` exists for local diagnostics and never changes the
receipt's `qualifying` field.

Generate the Buildchain-owned npm paper package contents from declared
publication facts:

```bash
buildchain publication-artifact npm-package --json
```

This command reads `project.type = "publication-artifact"`,
`publication.version`, and `[publish] kind = "npm-paper-package"` plus
`publish.package`; it writes `.buildchain/publication/npm-package` by default.
The `paper-release.yml@v3` reusable workflow uses the same command before
running the standard npm publish transaction.

The command writes `.buildchain/publication/publication-artifact.json`,
`.buildchain/publication/publication-artifact-passport.json`, a source bundle,
and, when `[publication.archive]` is configured,
`.buildchain/publication/publication-registry.json` by default. See
[`publication-artifacts.md`](publication-artifacts.md) for the repository
contract, pinned LaTeX builder, and reusable workflow.

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
  --release-passport https://github.com/kungfu-systems/buildchain/releases/download/v3.0.0/buildchain.release.json \
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
  --tag v3.0.0 \
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
  --tag v3.0.0 \
  --repository kungfu-systems/buildchain \
  --assets-dir dist \
  --publish-evidence-json .buildchain/release-evidence/v3.0.0/evidence.json \
  --transaction-json .buildchain/release-state/v3.0.0/state.json \
  --package-set-json package-set.json \
  --impact-json impact.json \
  --trusted-publishing-json trusted-publishing.json \
  --anchor-manifest-json libnode.release.json \
  --build-summary-json .buildchain/artifacts/build-summary.json \
  --platform-manifest-json .buildchain/artifacts/linux-x64/manifest.json \
  --platform-manifest-json .buildchain/artifacts/darwin-arm64/manifest.json \
  --platform-manifest-json .buildchain/artifacts/win32-x64/manifest.json \
  --dist-tag-evidence-json .buildchain/release-evidence/v3.0.0/dist-tag-evidence.json \
  --kfd-1-witness-json .buildchain/kfd/kfd-1/contract-world.witness.json \
  --kfd-2-claim-json .buildchain/kfd/kfd-2/release-claims.json \
  --kfd-3-prebuild-witness-json .buildchain/kfd/kfd-3/collaboration-interface.prebuild.json \
  --kfd-3-artifact-verify-cmd "kungfu agent verify --json" \
  --release-extra-json '{"channel":"release","targetRef":"release/v3/v3.0"}' \
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

`--invariant-passport-json` attaches a product-owned invariant Passport to the
release gate and may be repeated. `--invariant-passport-cmd` runs a product
command that emits one Passport JSON document. Buildchain verifies the
Passport root, exact clean source identity, `verified` verdict, complete
platform coverage, and residual-risk shape; it does not redefine the product's
invariant semantics. Declared invariant Passport input is fail-closed.
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

For a promote-only stable transaction, Buildchain can derive a patch-level
release-governance ledger when the PR-stage release-candidate passport proves
the stable source tree is exactly the previously qualified candidate tree.
This fallback is unavailable when candidate evidence is absent, stale, or not
tree-equivalent.

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
buildchain verify artifact npm:@kungfu-tech/libnode@22.22.3-kf.3-alpha.18 \
  --repository kungfu-systems/libnode \
  --tag v22.22.3-kf.3-alpha.18 \
  --json
```

`verify artifact` computes or obtains the subject digest, discovers the
detached release passport, verifies the passport, then requires that the
subject digest appears in the passport's release assets, package set, publish
evidence, or artifact evidence. Outcomes are explicit: `pass`, `fail`, or
`unverifiable`. A filename is only a hint; trust comes from digest equality.
For `npm:<name>@<version>` subjects, Buildchain resolves `dist.integrity` from
the npm registry before matching passport evidence. Use `--npm-registry <url>`
to verify packages from a custom registry; otherwise Buildchain uses
`npm_config_registry` or `https://registry.npmjs.org/`.

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

Seal an exact artifact verification with the Node API, then verify or project
the resulting KFX admission envelope without reconstructing its roots:

```bash
buildchain verify artifact-envelope envelope.json \
  --assessment-time 150 \
  --expected-root sha256:... \
  --expected-issuer buildchain.libkungfu.dev \
  --expected-publisher kungfu-systems \
  --expected-contract buildchain.release/v1 \
  --json

buildchain project kfx-admission envelope.json \
  --assessment-time 150 \
  --json
```

Both commands call the public artifact-verification-envelope verifier. The
projected `attestation`, `trustInputs`, and `kfdAssessment` are direct copies of
the sealed envelope, and `envelopeRoot` stays identical across Node and CLI.
See [`artifact-verification-envelope.md`](artifact-verification-envelope.md).

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
buildchain release --dry-run --target-ref alpha/v3/v3.0
buildchain release --dry-run --target-ref release/v3/v3.0 --sha <verified-sha>
buildchain release dry-run --target-ref publish-gate/major --source-ref release/v3/v3.0
buildchain release explain --target-ref alpha/v3/v3.0 --json
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
buildchain transaction inspect --version v3.0.1-alpha.2
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

- `v3.0.3-alpha.0` publishes to npm with dist-tag `alpha`.
- `v3.0.2` publishes to npm with dist-tag `latest`.
- moving refs such as `v3`, `v3.0`, and `v3.0-alpha` do not match the publish
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
