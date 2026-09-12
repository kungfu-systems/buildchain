---
status: active
period: ongoing
theme: buildchain-contributing
doc_type: process-rule
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-12
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-12
  visible_context: Repository contribution rules and implementation naming and release transition changes.
  invisible_context_boundary: No private credentials or unpublished external release state.
---

# Contributing to Buildchain

Thanks for your interest in Buildchain. This guide covers how to build the
project, the repository conventions, and how changes are proposed and released.

## Feedback, questions & security

All project contact happens through GitHub - there is no email support channel.

- **Bugs, feature requests, questions, documentation issues** - open a
  [GitHub issue](https://github.com/kungfu-systems/buildchain/issues/new/choose).
- **Code and documentation changes** - open a pull request.
- **Security vulnerabilities** - report them privately, never in a public issue.
  See [`SECURITY.md`](SECURITY.md).

Please do not include secrets, credentials, tokens, private logs, or other
sensitive material in issues or pull requests.

## Prerequisites

- Node.js 24
- Corepack with pnpm 11
- Go 1.25 for workflow validation paths that exercise Go setup

Buildchain's reusable workflow consumers may build with npm, yarn, pnpm, CMake,
Conan, Python, Docker, or other tools through lifecycle commands. This
repository itself is a Node/pnpm workspace.

## Repository layout

The [code organization contract](docs/code-organization.md) defines the layers.
Consumer APIs and hosted job boundaries live in `.github/workflows`; semantic
node adapters live in `actions/<capability>/<group>/<operation>`; JavaScript business logic
lives in `packages/core/<capability>`; authoritative Rust domains and the native
host live in `crates`. `bin` contains the CLI entry, and `scripts` contains only
repository tooling. Schemas, ownership declarations and tests live in
`contracts`, `architecture` and `tests`.

Do not add historical aliases or compatibility forwarders. Update every owned
caller and generated artifact when moving a contract or implementation.

## Build and verification

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` performs the repository done-check:

- validates inventory data;
- lints all root workflows, including hidden reusable workflows;
- runs unit tests with `node --test`;
- rebuilds action bundles through each action package.

For narrower checks during development:

```sh
pnpm run test:unit
pnpm run check:workflows
pnpm run build
npm pack --dry-run --json --registry=https://registry.npmjs.org/
```

## Workflow organization

All workflows remain directly under `.github/workflows/`. The finite role and
category vocabulary is enforced by `architecture/workflow-taxonomy.json`:

| Role | Filename | Scope |
| --- | --- | --- |
| Public | `public-<category>-<purpose>.yml` | Consumer entry |
| Component | `.<category>-<purpose>.yml` | Advanced reusable component |
| Self | `self-<category>-<purpose>.yml` | Buildchain repository automation |

Categories are only `build`, `release`, and `ops`. Register the identity, role,
category, purpose, owner, lifecycle status, invocation, and rationale before
adding its derived filename. The [Workflow Catalog](docs/workflow-catalog.md)
lists every canonical API and component path; self workflows have one
event entry. Retired paths have no generated aliases. A matching prefix alone does not admit an unregistered workflow.

Run `pnpm run generate:workflows`, `pnpm run check:workflows`, then the full
`pnpm run check`. The required Verify lifecycle runs this gate on PRs, merge
queue candidates, and pushes. Policy, enforcement, and ownership changes require
independent `@kungfu-origin` review. A development merge does not publish a floating channel. Consumers adopt the
new API only after that channel publishes it and their contract locks are refreshed.

## Generated files

GitHub Actions consume committed bundles. When changing an action
implementation, run the action build and commit the updated `dist/index.js`
alongside the source files.

## Commit messages

- Write commit messages and pull request descriptions in **English**.
- Follow lightweight [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`), for example `fix(publish): resume finalizing refs`.
- Sign every commit with the Developer Certificate of Origin:

```sh
git commit -s -m "docs: add public repository onboarding"
```

The sign-off adds a line like:

```text
Signed-off-by: Your Name <you@example.com>
```

Pull requests are checked automatically; every commit must include this line.

## Branches, pull requests & releases

Development happens on channel branches per version line, promoted by pull
request:

```text
dev/vX/vX.Y -> alpha/vX/vX.Y -> release/vX/vX.Y
release/vX/vX.Y -> publish-gate/major
```

- Open normal changes against the relevant `dev/*` branch.
- Treat `dev/vX/vX.Y` branches as protected development channels. Do not use
  them for direct ad-hoc commits. Work from `feature/*`, `fix/*`, `chore/*`,
  `docs/*`, `ci/*`, or `refactor/*` branches and open a PR into the target dev
  line.
- Repositories may call
  `.github/workflows/public-ops-dev-auto-merge.yml` from their own scheduled or manual
  wrapper to merge ready, conflict-free dev PRs. The wrapper is policy-gated:
  required checks, ready/block labels, same-repository heads, approvals,
  branch prefixes, max merges, and dry-run are all declared inputs.
- Ordinary build callers use `build.yml@v4` or `build.yml@v4-alpha` with
  project settings in `buildchain.toml`. Every public workflow uses the central
  runtime entry: transient `runtime-ref`, contract lock, then entry default.
  Validate the implementation before protected Dev, publish Alpha, and qualify
  the published consumer entry. See `docs/runtime-entry.md`.
- Merging into `alpha/*`, `release/*`, or `publish-gate/major` expresses a
  release intent. Buildchain promotion then creates version-state commits,
  exact tags, floating tags, npm publish evidence, and next-alpha state.
- Manual alpha publication requires an explicit protected source SHA and passes
  the same source qualification and fresh hosted admission as automatic publication.
  Use `runtime-ref` to select the execution runtime. Set recovery inputs only when
  resuming an existing transaction; a first publication leaves them empty. Stable
  publication continues through the protected automatic channel path.

See [`docs/release-governance.md`](docs/release-governance.md),
[`docs/release-flow.md`](docs/release-flow.md), and
[`docs/runtime-train-validation.md`](docs/runtime-train-validation.md).

## License

By contributing you agree that your contributions are licensed under the
project's [Apache License 2.0](LICENSE). Buildchain uses the Developer
Certificate of Origin (DCO) and does not require a Contributor License Agreement
(CLA).

## Implementation names

Name implementation directories, scripts, functions, and runtime work directories
for their responsibility. Product generation prefixes such as `v4-` are rejected
by `pnpm run check:implementation-naming`, including nested JavaScript bindings
and Rust declarations. `architecture/implementation-naming.json` records the
current implementation identities and prohibited generation prefixes. Published schema identities, hash
domains, selectors, runner labels, API compatibility keys, and exact historical
evidence keep their established identities; they do not name new implementations.

Stable completion under `semver/auto` prepares the next patch at `alpha.0` from
the exact current protected development commit. See the generated
[next-development contract](docs/next-development-transition.md) for retry,
independent review, and publication-preservation behavior.
