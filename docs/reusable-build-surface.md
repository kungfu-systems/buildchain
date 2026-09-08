---
status: draft
period: ongoing
theme: buildchain-reusable-build
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-08
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-08
  invisible_context_boundary: No private credentials or unrelated repositories inspected.
---

# Reusable Build Surface

A project declares its build in `buildchain.toml`. The reusable workflow owns
job sequencing, admission, runner boundaries and evidence aggregation. Ordinary
single-project calls have no inputs:

```yaml
permissions:
  actions: read
  contents: read
  issues: write
  id-token: write
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/build.yml@v4
```

Use `@v4-alpha` to select the alpha runtime. The exact called workflow SHA is
the runtime SHA; a second runtime selector cannot override it. Both the public
`build.yml` and the `.build.yml` backbone expose exactly one optional input:
`config-path`. Neither accepts command overrides, runtime refs, arbitrary JSON
configuration or legacy aliases.

## Project discovery

At the repository root, exactly one of `.buildchain/buildchain.toml` and
`buildchain.toml` must exist. Missing or ambiguous configurations fail before
matrix scheduling. A nested project is selected with its configuration location:

```yaml
jobs:
  native:
    uses: kungfu-systems/buildchain/.github/workflows/build.yml@v4-alpha
    with:
      config-path: packages/native/.buildchain/buildchain.toml
```

The config location determines the project working directory. Planning and
lifecycle execution discover the same file. Absolute paths, parent traversal,
symlink escape, malformed TOML and unknown `[build]` keys fail closed. A
configuration locator cannot carry a profile override or execution authority.

## Project configuration

```toml
schema = 1

[lifecycle.install]
command = "corepack pnpm install --frozen-lockfile"

[lifecycle.build]
command = "corepack pnpm build"

[lifecycle.verify]
command = "corepack pnpm test"

[build]
environment = "github-hosted"
timeout_minutes = 120
fail_fast = false

[build.tools]
node = "24"
rust = "stable"
go = "1.25.x" # optional; omitted toolchains are not installed

[build.artifacts]
name = "my-library"
paths = ["dist"]
required_paths = ["dist/library.js"]
min_files = 1
release_candidate = true
retention_days = 14
compression_level = 0
```

Commands remain exclusively in `[lifecycle]`. The backbone explicitly invokes
install, build and verify in that order on each platform. Build is required;
install and verify are required when declared. Unneeded stages require no
additional boolean setting. Per-stage lifecycle timeout declarations retain
precedence over the build timeout fallback.

Artifact paths and required file paths are relative to the selected project.
Platform artifact names derive from the configured base name,
platform and source SHA; callers do not supply naming templates. The final
manifest checks `min_files`, `max_files`, `min_total_bytes` and `required_paths`.

Other optional project sections are:

| TOML section | Responsibility |
| --- | --- |
| `build.diagnostics` | Process sampling and expected parallelism |
| `build.verification` | Consumer-produced verify substage evidence location |
| `build.finalization` | Verification of final signed bytes and platform placement |
| `build.transport_smoke` | Transport simulation scenario and artifact root |
| `build.attestation` | Subject path and attested platform |
| `build.macos_signing` | App path and sealed-input platform |
| `build.contract` | Compatibility and drift reporting policies |
| `build.evidence` | Repository files containing gate and candidate-family evidence |

Declarative signing targets continue to belong to `[signing.artifacts]`.
The formal signing authority remains `authority/v3/v3.0/artifact-signing`
with the protected `buildchain-artifact-signing` environment.
Credentials, authority profiles and signer identities cannot be supplied through
that declaration. See [Release Candidate](release-candidate.md)
and [GitHub Artifact Attestation](github-artifact-attestation.md).

## Governed environments

`build.environment` selects a profile in
[`architecture/build-environments.json`](../architecture/build-environments.json)
from the exact Buildchain runtime. Infrastructure owners maintain runner
presets/platforms, Linux container images, mirrors, cache transport, artifact
relay settings and credential-island environments there. Adding a runner label
or provider role requires reviewing that profile; project TOML cannot redefine
it. Secrets still cross explicit workflow secret/environment boundaries.

The initial profiles are `github-hosted`, `github-hosted-container`,
`kungfu-v4-native` and `kungfu-v4-self-hosted`. The container profile uses the
existing digest-pinned `kungfu-verify` image. Native and container jobs remain
separate because GitHub selects `runs-on` and `container` before executing
steps. Their shared behavior is owned by these composite actions:

| Action | Owner responsibility |
| --- | --- |
| `build-lifecycle-stage` | Lifecycle manifests, sampling and diagnostics |
| `build-signing-request` | Unsigned requests and detached signing control inputs |
| `build-verification-evidence` | Independent substage verification and failure evidence |
| `build-attestation-policy` | Source-bound artifact attestation policy |
| `build-agent-hub-evidence` | Agent Hub conformance evidence |
| `build-artifact-transfer` | GitHub and S3 transport plus payload manifests |

The backbone still owns install → build → verify order, job dependencies,
permissions, signing control, credential-island placement and final aggregation.
A composite's internal receipt inputs transport already resolved facts; they
are not additional reusable-workflow configuration inputs.

## Identity and admission

The configuration resolver reads the exact consumer source without executing
consumer commands. It emits a deterministic plan/root binding configuration
bytes, source SHA, called-workflow SHA, selected environment, toolchain and
cache roots. Trust checks run before project execution or privileged runners.

Tracked consumer workflows use `@v4` or `@v4-alpha` and commit both
`.buildchain/contract-lock.json` and `.buildchain/alpha-contract-lock.json`.
The called channel selects its matching lock. Source-persisted train/SHA
selectors and mismatched locks remain forbidden. Ordinary builds have no
runtime-override path; specialized release/recovery entry points keep their
separate, bounded admission contracts.

Bootstrap owns its admitted release and recovery capabilities. It is not an
alternate parameter envelope for ordinary builds and is not injected into the
build backbone. Release promotion consumes an already sealed candidate and
must verify the source, artifacts and receipts independently.

## Evidence and failure behavior

The workflow retains runtime/source identity, build and diagnostics summaries,
Release Candidate Passport, signing/finalization and controller receipt outputs.
The public facade forwards those outputs from the single backbone execution.
Platform manifests include deterministic payload hashes; transport preserves
hidden artifacts and provenance. Substage failure evidence is collected even
when verify fails. Untrusted events cannot reach build runners.

Signing authority and credential-island jobs remain separate from ordinary
build execution. Imported signed bytes undergo consumer verification before
manifests are recomputed. Release builds produce candidates; registry publishing
belongs to the protected release path.

## Maintaining the contract

Update the TOML parser and plan resolver, owner contracts, affected consumers
and tests together. Run `node scripts/generate-channel-build-workflow.mjs`,
`pnpm run generate:workflows`, generated reference/site checks and the full
`pnpm run check`. Breaking input removal is intentional: migrate old `with`
settings to TOML and remove them from calls; no compatibility forwarding exists.

The Buildchain fixture at `fixtures/libnode-shaped/buildchain.toml` exercises
native macOS/Windows and Linux-container builds through this public contract.
