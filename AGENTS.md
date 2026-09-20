---
status: active
period: ongoing
theme: buildchain-layered-architecture
doc_type: implementation-guide
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-20
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-20
  visible_context: Buildchain 4.1 source, architecture registries and local validation.
  invisible_context_boundary: No unpublished release or external consumer qualification is claimed.
---

# AGENTS.md

This file orients coding agents and people working with Buildchain. It is a
router, not a duplicate: it points to the authoritative documents rather than
restating them.

## Are you using Buildchain, or building it?

- **Adopting Buildchain for the first time** - follow the 15-30 minute
  [`Golden Path`](docs/getting-started.md).
- **Looking up a CLI command** - use the generated
  [`CLI Reference`](docs/cli-reference.md).
- **Writing Node build automation** - use the generated
  [`Node API Reference`](docs/node-api-reference.md).
- **Exploring advanced workflows, release governance, or product
  capabilities** - start at the [`Documentation Map`](docs/MAP.md).
- **Building or contributing to this repo** - read the rest of this file, then
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Using this repo as a Buildchain consumer

The consumer-facing self boundary is `.buildchain/buildchain.toml`, two generated
callers (`.github/workflows/buildchain.yml` and `buildchain-recover.yml`),
tool-maintained contract locks, and necessary provider permissions. The normal
caller invokes the published `public-ops-pipeline.yml`; recovery accepts only an
exact attempt and an optional repaired runtime through `public-ops-recover.yml`.
No repository-specific runtime selection or recovery exception is allowed.

Both callers use the published `@v4` entry and the default
`.buildchain/buildchain.toml` path. The pipeline reads policy at the same path on
its protected target branch, so each target must contain the schema-2 policy
before its first pipeline PR. The TOML declares `feature/*`, `fix/*`, `chore/*`,
`docs/*`, `ci/*`, and `refactor/*` development routes. The tool-maintained stable
contract lock binds the qualified published runtime.

Products declare their own install, build, and verification commands in TOML.
Publication, source qualification, reviews, merge queues, provider readback and
recovery belong to the published runtime. Internal workflow libraries and actions are implementation only. The complete
public reusable API is `public-ops-pipeline.yml` and `public-ops-recover.yml`;
self callers use the same public reusable-workflow contract as every other consumer.

## Building this repo

Read [Code organization](docs/code-organization.md) before changing implementation
layout. Keep workflows, action adapters, JavaScript modules and Rust domains in
their declared responsibility layers. No historical compatibility entry is retained.

Buildchain is a pnpm workspace running on Node 24:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run check
```

Workflow paths are governed by [`architecture/workflow-taxonomy.json`](architecture/workflow-taxonomy.json)
and the generated [`Workflow Catalog`](docs/workflow-catalog.md). Before adding,
renaming, or editing workflow YAML, register its role (`public`, component `.`,
or `self`) and category (`build`, `release`, or `ops`). Use the derived filename;
do not invent prefixes, categories, or compatibility aliases. Edit canonical
implementations, run `pnpm run generate:workflows`, and pass
`pnpm run check:workflows` plus the full check. Taxonomy and gate changes require
independent `@kungfu-origin` review through CODEOWNERS.

Buildchain v4 Stage Capsule checkpoint work is governed by
`architecture/platform-stage-checkpoints.json`. Agents must use that single
platform/stage declaration for shadow emission and clean-process restore. Do
not add undeclared runner-only inputs, outputs, environment, provider effects,
credentials, or production stage-skipping authority.

Stage Capsule resume planning is governed by
`architecture/stage-capsule-resume-planner.json`. Keep its Rust core and
TypeScript projection pure and byte-identical; explicit provider/release-tail
effects always require readback and never become Capsule reuse.

Stage Capsule qualification and Wave 2 reconciliation remain governed by
`architecture/stage-capsule-qualification.json`. Its prior standalone public
Canary caller is explicitly historical; its shadow-only authority and retained
evidence do not grant publication or production reuse. Current product verification
runs the committed WASM checks, clean-process checkpoint restoration, and resume
planning on Linux, macOS and Windows, with the same pinned Linux container
backbone checks. These are product tests, not consumer-side delivery controllers.

Normal self workflows and recovery share central runtime selection. The
central entry resolves it once, and every business job uses that selected runtime.
Persist only `@v4` or `@v4-alpha` in caller source, with matching stable and alpha contract locks
maintained by the tooling. A source-persisted exact commit SHA or train is not a durable entry selector;
exact SHAs belong in locks and provenance. A repaired train is a trusted,
non-persistent recovery input and must retain the original attempt evidence.
The optional repair selector is a trusted non-persistent runtime input.

Changes to this consumer wiring, its required product checks, or publication
gates require `@kungfu-origin` approval through the protected PR workflow.

`pnpm run check` validates inventory data, generated public references and site
bundle drift, lints root workflows, runs unit tests, and rebuilds every action
bundle.

Before broad maintenance or consolidation work, read the current engineering
handoff in
[`2026-07-10-buildchain-consolidation.md`](.github/retrospectives/2026-07-10-buildchain-consolidation.md).

## Proposing changes

- Open pull requests against the relevant `dev/*` channel branch.
- If a Buildchain change needs downstream validation before stable refs move,
  publish a `train/v4/v4.1/<capability>` ref and include the validation request
  described in [`docs/runtime-train-validation.md`](docs/runtime-train-validation.md).
  After validation succeeds, do not leave the train as a pending merge item:
  merge the pull request into the active `dev/*` mainline and run the requested
  alpha or release promotion. The train may remain for a retention window as a
  fast-use and rollback channel; periodic cleanup handles old trains.
- Write commit messages and PR descriptions in English, using lightweight
  [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`).
- Sign off every commit with the DCO: `git commit -s`.
- Bugs, feature requests, questions, and documentation issues go through GitHub
  issues; security vulnerabilities use private vulnerability reporting - see
  [`SECURITY.md`](SECURITY.md).
- Brand, hosted-service, and upstream-provider boundaries are documented in
  [`TRADEMARK.md`](TRADEMARK.md), [`ACCEPTABLE_USE.md`](ACCEPTABLE_USE.md), and
  [`PROVIDER_COMPLIANCE.md`](PROVIDER_COMPLIANCE.md).

## Ground rules

- Never include secrets, credentials, tokens, or private logs in code, commits,
  issues, or pull requests.
- Do not build or document official release integrations that bypass provider
  protections, hide credential boundaries, or forge release evidence.
- Keep generated action bundles in sync with source changes.
- When public documentation, CLI usage authority, or package exports change,
  follow the [Site Bundle Contract generation steps](docs/site-bundle-contract.md#generation)
  and commit the updated generated references and `dist/site/` facts.
- Keep documentation in sync with behavior, especially release governance and
  reusable workflow contracts.
- [`docs/MAP.md`](docs/MAP.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md) are the
  sources of truth; when this summary and they disagree, follow them.
