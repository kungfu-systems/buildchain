# Publication Artifact Workflow

Buildchain supports `project.type = "publication-artifact"` for repositories
that produce auditable papers, reports, specifications, or similar publication
packages. These repositories are artifact producers. They should not be forced
to become `web-surface` repositories just because a downstream site later
renders the paper.

The split is:

```text
paper repo = source, PDF, metadata, source bundle, publication manifest
papers site = layout, navigation, public web surface, downstream rendering
```

## Configuration

The paper repository owns `.buildchain/buildchain.toml`:

```toml
schema = 1

[project]
type = "publication-artifact"
name = "paper-observer-declared-timelines"

[publication]
kind = "paper"
title = "Observer-Declared Timelines for Real-World Agent Work"
version = "0.1.0"
primary_artifact = "_build/main.pdf"
artifact_paths = ["_build/main.pdf"]
metadata_paths = ["README.md", "docs/MAP.md"]
source_paths = ["paper", "README.md", "LICENSE", "Makefile"]
site_consumers = ["papers.libkungfu.dev"]
manifest_path = ".buildchain/publication/publication-artifact.json"
source_bundle_path = ".buildchain/publication/source.tar.gz"

[publication.archive]
id = "observer-declared-timelines"
canonical_url = "https://papers.libkungfu.dev/observer-declared-timelines/"
latest_url = "https://papers.libkungfu.dev/observer-declared-timelines/latest/"
latest_evidence_url = "https://papers.libkungfu.dev/observer-declared-timelines/latest/buildchain.release.json"
immutable_base_url = "https://papers.libkungfu.dev/archive"
registry_path = ".buildchain/publication/publication-registry.json"

[publication.toolchain]
type = "latex-docker"
image = "ghcr.io/kungfu-systems/build-images/latex-pdf-builder"
digest = "sha256:c20f3809e96836c1c78e97c76939d12f1de3fed0ea9b7c40c43332ec2ea480f8"
command = "latexmk -pdf -outdir=_build paper/main.tex"

[publish]
kind = "npm-paper-package"
package = "@kungfu-tech/paper-observer-declared-timelines"
auth = "trusted-publishing"

[lifecycle.build]
command = "make pdf"

[lifecycle.verify]
command = "make check"
```

`primary_artifact` is the human-facing publication output, usually a PDF.
`source_paths` are archived into a source bundle. `metadata_paths` are hashed
and recorded so a site can consume the paper facts without scraping prose.

`publication.archive` turns the publication into an append-only public archive
contract:

- `canonical_url` is the stable human reader page.
- `latest_url` and `latest_evidence_url` are movable aliases for the latest
  reader page and latest evidence.
- `immutable_base_url` plus `id` and `publication.version` produce a versioned
  prefix such as
  `https://papers.libkungfu.dev/archive/observer-declared-timelines/v0.1.0/`.
- `immutable_url_prefix` can be used instead when the repository already owns
  the full version prefix.
- `registry_path` records every published version and its manifest, passport,
  source bundle, primary artifact, URLs, and SHA-256 digests.

Immutable archive prefixes are append-only. Do not run site deployment commands
with `sync --delete` or equivalent deletion semantics over those prefixes. A
same-version republish is allowed only when the immutable digest is unchanged;
if PDF, source bundle, route, metadata, or toolchain evidence changes for an
existing version, Buildchain fails before the registry is rewritten.

The Buildchain web-surface adapter consumes this boundary from a surface-local
`manifest.json` whose `archivePolicy.contract` is
`kungfu-buildchain-publication-archive-policy`. It excludes the derived archive
root from every owning or parent `sync --delete`, verifies existing object
digests, uploads only missing immutable files with `--no-overwrite`, and verifies
them again before mutable site content is synchronized. A current package set
does not need to rebuild or enumerate every historical version: the protected
archive root remains outside deletion even when older versions disappear from
the current artifact.

`publication.toolchain` makes the source-to-PDF transformation part of the
machine-readable contract. `latex-docker` is the preferred LaTeX profile. The
Buildchain paper scaffold and reusable workflow default to
`ghcr.io/kungfu-systems/build-images/latex-pdf-builder:v1.2.0`, pinned by the
digest above. The workflow pulls the declared image by digest and runs the
declared command in that pinned container. `custom-command` remains available
for compatibility, but the passport records it as lower trust because
Buildchain can record the command boundary without proving the compiler or
LaTeX distribution digest.

## Reproducibility Gate

Alpha and release admission require
`.buildchain/publication/reproducibility-receipt.json`. Buildchain creates the
receipt by cloning the exact checked-out Git commit into two independent local
repositories, assigning each build a separate home and npm cache, and deriving
`SOURCE_DATE_EPOCH` from the source commit. A pinned `latex-docker` build runs
with UTC, `C.UTF-8`, no build-time network, and the exact image digest declared
in `[publication.toolchain]`.

Each clean build independently creates the PDF set, source bundle, publication
manifest and passport, append-only registry, synthesized npm package directory,
and an actual npm tarball. After qualification, Buildchain copies the first
qualifying tarball into the promoted publication candidate instead of deleting
it with the temporary clean build. The receipt compares exact bytes and records:

- source repository, commit, tree, and `SOURCE_DATE_EPOCH`;
- toolchain image, digest, command, and toolchain identity root;
- every artifact and evidence path with byte size and SHA-256;
- npm tarball SHA-256, SHA-1 shasum, and `sha512` integrity;
- per-build output-set roots and the first differing field or artifact.

The gate is fail-closed. A build-only `custom-command` run can diagnose byte
drift and promote its byte-identical local output with
`--allow-unpinned-toolchain`, but it is never a qualifying publication receipt.
Any workflow that prepares a publishable paper package accepts only a
digest-pinned toolchain and promotes the first clean build into the publication
candidate only after both builds are byte-identical. The receipt remains
outside the npm tarball to avoid a circular digest; it binds the tarball bytes
from the surrounding sealed publication evidence.

`publish.kind = "npm-paper-package"` declares that Buildchain, not the consumer
repository, owns the standard paper npm package shape and release transaction
mechanics. `publish.package` is the public npm package that contains the PDF,
publication manifest, publication passport, optional archive registry, source
bundle, and declared metadata files.

## Reusable Workflow

Consumer repositories that only need to build and upload paper evidence can
call the build-only wrapper directly:

```yaml
jobs:
  publication:
    uses: kungfu-systems/buildchain/.github/workflows/publication-artifact.yml@v3
    with:
      toolchain-type: config
      verify-command: make check
      artifact-name: observer-declared-timelines
      buildchain-contract-lock-path: .buildchain/contract-lock.json
```

The build-only workflow:

- resolves the Buildchain runtime and checks the floating contract lock before
  any paper build runs;
- resolves the declared publication toolchain from `[publication.toolchain]` or
  workflow inputs;
- hydrates authenticated registry history before building so both clean
  candidates include the same append-only history;
- for `latex-docker`, pulls the pinned build-images LaTeX builder digest and
  runs two independent clean builds with the reproducibility policy above;
- for `custom-command`, runs the declared command and records the lower-trust
  boundary in the passport, but refuses publication qualification;
- runs the verify command;
- creates a source bundle from `publication.source_paths`;
- writes `.buildchain/publication/publication-artifact.json`;
- writes `.buildchain/publication/publication-artifact-passport.json`;
- writes a qualifying
  `.buildchain/publication/reproducibility-receipt.json`;
- when `[publication.archive]` is configured, writes
  `.buildchain/publication/publication-registry.json` and verifies same-version
  immutability;
- uploads one GitHub artifact containing the PDF, manifest, passport, optional
  registry, and source bundle.

It does not publish npm packages, deploy web pages, or create GitHub Releases.

The paper release preset additionally hydrates every prior published package
registry from the npm registry before generating the current manifest. npm
package integrity authenticates each downloaded source; Buildchain verifies the
registry self-digest, merges immutable records, and fails if a cumulative
registry drops an accepted version or changes immutable route/artifact facts.
The synthesized package therefore carries complete history even on a clean
runner. Its cumulative registry and file SHA-256 values are bound into the paper
release build summary and release passport evidence.

## Paper Release Preset

Paper repositories that publish a versioned npm package should use the
Buildchain-managed release preset instead of copying npm transaction scripts or
promotion YAML:

```yaml
name: Paper Release

on:
  push:
    branches:
      - alpha/v1/v1.0
      - release/v1/v1.0
  workflow_dispatch:

jobs:
  paper-release:
    uses: kungfu-systems/buildchain/.github/workflows/paper-release-sealed.yml@<exact-buildchain-sha>
    permissions:
      actions: read
      checks: write
      contents: read
      id-token: write
      issues: write
    with:
      buildchain-ref: <exact-buildchain-sha>
      publisher-workflow-path: .github/workflows/paper-release.yml
      toolchain-type: config
      verify-command: make check
      artifact-paths: _build/paper-name.pdf
      buildchain-contract-lock-path: .buildchain/contract-lock.json
    secrets:
      BUILDCHAIN_GENERATED_WRITE_APP_CLIENT_ID: ${{ secrets.BUILDCHAIN_GENERATED_WRITE_APP_CLIENT_ID }}
      BUILDCHAIN_GENERATED_WRITE_APP_PRIVATE_KEY: ${{ secrets.BUILDCHAIN_GENERATED_WRITE_APP_PRIVATE_KEY }}
      BUILDCHAIN_GENERATED_WRITE_TOKEN: ${{ secrets.BUILDCHAIN_GENERATED_WRITE_TOKEN }}
```

The sealed preset does not use a long-lived token for npm publication. It
prefers a repository-scoped GitHub App installation token for generated
repository writes and accepts `BUILDCHAIN_GENERATED_WRITE_TOKEN` as an
equivalent narrow compatibility authority. The deprecated
`BUILDCHAIN_PROMOTION_TOKEN` name remains accepted for existing consumers, but
there is no `github.token` fallback for generated writes. npm publication
remains bound to GitHub OIDC trusted publishing. The preset builds and packages the
paper in a read-only job, then a credential-free authority job downloads that
exact candidate, audits the external control plane, and seals a capability over
the source tree, Buildchain runtime, controller receipt, PDF, and npm package
bytes. Only the final job receives write and OIDC permissions; it downloads the
admitted candidate, recomputes the capability binding, and publishes without
executing consumer build commands. npm binds the OIDC identity to the consumer
workflow named by `publisher-workflow-path`.

The preset:

- uses the exact Buildchain SHA admitted by the provisioning authority and
  binds it into the caller bytes, contract lock, publication candidate, and
  authority capability;
- builds the PDF through the declared pinned LaTeX Docker toolchain or custom
  command in a read-only job;
- verifies the paper repository;
- writes the publication manifest, publication passport, optional archive
  registry, and source bundle;
- synthesizes an npm package from `[publication]` and `[publish]` declarations
  under `.buildchain/publication/npm-package`;
- computes npm-style `sha512` integrity from `npm pack --dry-run` and passes
  it as `publish-required-artifacts-json`;
- creates a `publish-gate/<alpha|release>/.../<version>` source lock for the
  channel commit and requires `promote-buildchain-ref` to verify that lock
  before any publish side effect;
- verifies the complete candidate again after authority and publishes the
  package through npm Trusted Publishing without rebuilding or repacking it;
- writes a typed sealed-bundle manifest that binds the candidate root, exact
  npm tarball, every GitHub Release asset, durable storage path, and resume
  command;
- persists the complete binary bundle to the transaction's durable release-state
  ref before npm receives credentials, allowing an empty runner to restore and
  verify the same bytes after interruption;
- writes Buildchain release/passport evidence; and
- creates or updates the exact-version GitHub Release by default, uploading
  every file declared by `publication.primary_artifact` and
  `publication.artifact_paths` alongside the release evidence.

Consumers can opt out of the GitHub Release with `github-release: false`, but
the default is on so downstream release propagation can observe
`release.published` without hand-written `gh release` steps.

The transaction exposes a stable publication progression:

```text
prepared -> sealed -> package-published -> alpha-complete
```

Stable publication ends at `release-complete`. If a run stops after npm but
before GitHub Release completion, the next run starts from
`package-published`, restores the sealed PDF and companion assets, and finishes
the release without invoking the paper build or `npm pack` again.

Declared publication artifacts are resolved from the generated publication
manifest rather than repeated in consumer workflow YAML. Publication fails
before upload if a declared artifact is missing or if its basename would
collide with another GitHub Release asset.

For npm Trusted Publishing, register the consumer workflow file that calls this
preset, for example `.github/workflows/paper-release.yml`, against the declared
package in npm. The trusted publisher is the consumer repository and workflow
file; the implementation still runs inside Buildchain's reusable workflow.

Standard paper repositories should not carry local copies of
`scripts/npm-publish-transaction.mjs`, package-generation scripts, or
promotion/ref-lock YAML. If the default package shape is insufficient, extend
Buildchain rather than forking the mechanics into each paper repository.

## CLI And Node API

### Unified paper operator surface

The `buildchain paper` command family assembles the existing publication
primitives into a resumable operator flow:

```text
scaffold/new or migrate/existing -> preflight -> bootstrap npm -> build -> alpha -> status -> resume
```

Each command emits a typed JSON envelope with `--json`. Dry-run is the default
for every external mutation. `scaffold --write` is limited to no-overwrite
local file creation. `migrate --write` is limited to the Buildchain-owned
contract lock, version pin, thin workflows, and provisioning authority; paper
content and publication configuration are preserved. `bootstrap npm --execute`, `alpha --execute`, and
`resume --execute` cross external authority boundaries and therefore require
explicit execution.

The evidence model is intentionally non-inferential:

| State                | Required evidence                                        |
| -------------------- | -------------------------------------------------------- |
| `scaffolded`         | Complete managed scaffold inventory                      |
| `governed`           | Compatible Buildchain contract lock                      |
| `admitted`           | Repository admission receipt                             |
| `bootstrapped`       | Successful public npm bootstrap receipt or registry fact |
| `trust-bound`        | Trusted publisher binding receipt                        |
| `content-ready`      | Declared source paths present                            |
| `artifact-sealed`    | Verified sealed publication bundle                       |
| `package-published`  | Exact package version visible in npm                     |
| `alpha-complete`     | Protected Alpha PR completion evidence                   |
| `staging-visible`    | Staging route evidence                                   |
| `production-visible` | Production route evidence                                |

`paper status` reports `satisfied`, `not-reached`, `blocked`, or `unknown` for
each state. It does not promote a state merely because a prior state is
complete. This makes a later `paper resume` safe: the command dispatches the
thin repository release workflow, while the workflow re-verifies durable
evidence and remains the publication authority.

Operationally, responsibility remains split:

- the paper repository owns content, declared metadata, and its thin
  build/release workflow;
- Buildchain owns scaffold shape, evidence contracts, reproducibility, sealed
  bundle mechanics, npm transaction mechanics, and resumption planning;
- GitHub branch protection and trusted publishing own authority transitions;
- the papers site consumes publication evidence and owns reader-facing
  rendering.

Daily work begins and ends through the repository-pinned v3 CLI:

```sh
pnpm paper:work:start -- golden-path
# edit, test, and commit paper source
pnpm paper:work:submit
```

The start plan derives `dev/vN/vN.M` from `publication.version` and requires
local HEAD to equal the exact canonical remote development SHA. The submit plan
allows only a non-protected work branch containing that SHA, a clean committed
tree, a normal fast-forward push, and a pull request back to the same derived
development branch. Neither command force-pushes, guesses a fork target, or
silently fetches and merges stale state.

Maintainers can inspect a sibling fleet without per-repository command copies:

```sh
buildchain paper fleet audit --root /path/to/papers --json
buildchain paper fleet update --root /path/to/isolated-paper-worktrees --json
```

Fleet update is dry-run first and accepts only isolated work branches. Its
typed plan carries exact-old and expected-new digests for the same owned
surfaces as `paper migrate`; `--write` also refreshes each pnpm lockfile. It
never rewrites paper content or publication configuration.

Run a local readiness check without network observations:

```sh
buildchain paper preflight --offline --json
buildchain paper status --json
```

Before real npm bootstrap, first inspect the default dry-run result:

```sh
buildchain paper bootstrap npm --json
```

Only after reviewing the package, repository, workflow, and dry-run evidence:

```sh
buildchain paper bootstrap npm \
  --execute \
  --confirm-public-package @kungfu-tech/paper-example \
  --json
```

Generate the publication manifest locally or in CI:

```sh
buildchain publication-artifact manifest --source-sha "$(git rev-parse HEAD)" --json
```

Prove the complete candidate from two clean builds:

```sh
buildchain publication-artifact reproducibility \
  --source-sha "$(git rev-parse HEAD)" \
  --promote \
  --json
```

Generate the npm package contents after the manifest exists:

```sh
buildchain publication-artifact npm-package --json
```

Node API:

```js
import {
  collectPublicationArtifact,
  writePublicationArtifact,
} from "@kungfu-tech/buildchain/publication-artifact";

import {
  collectPublicationPackageFacts,
  preparePublicationNpmPackage,
} from "@kungfu-tech/buildchain/publication-package";

import { verifyPublicationReproducibility } from "@kungfu-tech/buildchain/publication-reproducibility";

import {
  createPublicationSealedBundle,
  verifyPublicationSealedBundle,
} from "@kungfu-tech/buildchain/publication-sealed-bundle";
```

`writePublicationArtifact()` is the single implementation used by the CLI and
the reusable workflow. The generated manifest records:

- publication title, kind, authors, and primary artifact;
- artifact paths, byte sizes, and SHA-256 digests;
- metadata paths and SHA-256 digests;
- source SHA, tree SHA, source files, and source bundle digest;
- publication toolchain type, image, digest, command, invocation mode, and trust
  classification;
- timestamp and reproducibility policy;
- downstream site-consumption hints;
- optional archive routes for canonical, latest, latest evidence, immutable
  version prefix, and public artifact URLs.

The companion publication artifact passport records the same source and
artifact evidence plus an explicit responsibility split. Buildchain proves
declared files and hashes; it does not peer-review paper claims.

When archive config is present, the registry uses the
`kungfu-buildchain-publication-artifact-registry` contract. A site repository
can render latest pages and historical version indexes from that registry
without rebuilding old PDFs from the latest npm package or paper source.

## Site Consumption

A downstream papers site should treat the publication manifest as the single
fact source for the artifact. The site owns rendering and navigation; it should
not reinterpret the paper repository as a web deployment source.
For registry-level routing, sites should first consume the package-owned
Buildchain fact source:

```text
node_modules/@kungfu-tech/buildchain/dist/site/publication-registry.json
```

or the equivalent package export:

```js
import registry from "@kungfu-tech/buildchain/site/publication-registry.json" with { type: "json" };
```

That registry uses the `kungfu-buildchain-publication-release-registry`
contract. It separates mutable canonical/latest reader routes from immutable
version prefixes, publication artifacts, source bundles, and passport evidence
so site repositories can render `/papers/**` without maintaining a parallel
fixture truth source.

For `paper-observer-declared-timelines`, the expected adoption path is:

```text
paper repo builds PDF + manifest + source bundle
paper repo updates publication-registry.json
papers site consumes publication-artifact.json
papers site consumes publication-registry.json for history
site renders paper page and links the PDF/source bundle
```

This mirrors web-surface governance without mixing producer and renderer
responsibilities.
