---
status: active
period: ongoing
theme: buildchain-golden-path
doc_type: technical-guide
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-23
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-23
  visible_context: Schema-2 initializer, shared caller generator and local validation code.
  invisible_context_boundary: Initialization does not prove hosted publication or provider authorization.
---

# Buildchain Golden Path

A consumer owns its product source and one schema-2 TOML declaration.
Buildchain generates two product-independent YAML callers: normal execution
and exact-attempt recovery. The published runtime owns delivery and publication.

## Install and initialize

In an existing npm product repository with a version in `package.json`:

```sh
pnpm add -D --save-exact @kungfu-tech/buildchain
pnpm exec buildchain init --type npm --package-manager pnpm
```

Use `--type binary` for a CMake product or `--type paper` for a PDF product.
`package`, `native`, and `publication-artifact` select the corresponding product
kind. `anchored-package` selects an npm product whose version is changed by a
reviewed source update rather than automatic version rewriting.

Initialization writes:

- `.buildchain/buildchain.toml`: products, artifacts, publication targets,
  version files, channel routes and protected review policy;
- `.github/workflows/buildchain.yml`: the normal `public-ops-pipeline.yml` caller;
- `.github/workflows/buildchain-recover.yml`: the `public-ops-recover.yml` caller;
- a managed consumer section in `AGENTS.md`;
- `release.json` as version source when a binary or Paper product has no package version.

Both YAML files are byte-identical across npm, binary and Paper projects.
Edit product install, build, verification and artifact declarations in TOML to
match your existing source. Keep the generated caller bytes unchanged. There
are no consumer publication commands, hidden controller scripts or provider
request payloads to maintain.

## Validate locally

```sh
pnpm exec buildchain validate --require-version-state
pnpm exec buildchain doctor --json
```

For npm products, `--require-lifecycle-stages install,build,verify` also checks
that every product declares those commands. Binary and Paper products can omit
an install stage. Run your product's declared build and verification commands
before opening the first PR.

`validate` checks the schema, declared version sources and both caller files.
`doctor` also checks the Git repository and, for npm products, package-manager
discovery. Local success establishes configuration validity; hosted qualification
and publication have their own source-bound results.

## Use the normal release path

Commit the generated files and product source. Complete repository permissions,
branch protection, independent reviewer configuration and provider authorization
once. When present, tool-maintained stable and Alpha contract locks select the
published runtime. Without a lock, the published entry uses its own exact runtime
commit; initialization does not invent a lock or require one to select that default.
Existing npm Trusted Publishing remains in use; normal releases do not require
an interactive npm login or a manually supplied publishing token.

Open a PR along a route declared in TOML: a feature branch into development,
development into Alpha, or Alpha into release. The same normal caller handles
build, protected delivery, publication, provider readback and next-development.
Follow the workflow's actual result and published Release Passport.

For an interrupted attempt, run `buildchain-recover.yml` with its exact attempt.
Supply a repaired runtime only when a runtime repair is needed. Do not supply
replacement source, artifacts or provider-effect parameters.

## Migrating old callers

Existing schema-1 consumers can keep their product configuration and the historical
workflow contracts listed in `architecture/consumer-upgrade.json`. These entry
files are generated from the maintained implementations, preserving historical
inputs, defaults, outputs and permissions. The compatibility paths do not insert
another reusable job, so existing required job contexts remain intact. A runtime
lock continues to select its exact runtime; upgrading a package does not silently
override the lock. Existing Trusted Publishing configuration remains in use.

The frozen compatibility boundary is the published v4.1.3 entry set, plus the
v4.0 build/check/release interfaces and the v4.0.9 delivery interface used by
older consumers. Regression fixtures record 11 calls from libnode, kfd and
taolu, including their v2/v3/v4 selectors. Those fixtures prove parameter and
secret admission; they do not by themselves prove a full hosted consumer release.
Local execution tests cover build artifacts, candidate identity, native delivery,
publication metadata, KFD witness comparisons, recovery pins and failure propagation.

The old final-version publication mode uses the current provider transaction.
Retained release callers preserve their existing permission envelope and npm
Trusted Publishing caller identity. KFD witness files and the two retained
read-only evidence commands are checked against the selected source and sealed
candidate, then included as rooted publication evidence. Arbitrary legacy
publishing or preparation commands are not qualified adapters and fail explicitly;
old phase-less delivery owner migration is not a verified upgrade path. A consumer
using these extensions needs separate qualification before upgrading.

Moving such a consumer to the schema-2 caller pair is an optional interface
migration, separate from updating Buildchain. Do not run the initializer over
an existing configuration as a prerequisite for a compatible version update.

Schema-1 product-specific workflow callers are not generated by this initializer.
The old `web-surface` and `infra-contract` initialization modes are outside the
current schema-2 npm/binary/Paper pipeline; initialization rejects them before
writing files. Their internal product modules remain available to maintainers.

Existing unrelated workflows or conflicting files stop initialization before
any write. `--force` replaces the declared generated files only; it does not
delete other workflows or follow symlinks. Move product commands into TOML and
remove obsolete consumer orchestration as part of an explicit migration.

See the [standard examples](../templates/minimal-consumer/),
[workflow catalog](workflow-catalog.md), [CLI reference](cli-reference.md), and
[Release Passport](release-passport.md).

`pnpm run check:golden-path` packs the local package, installs it in a temporary
consumer, initializes and validates the shared caller pair, and executes the
fixture product build and check. It performs no hosted publication.
