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

`publication.toolchain` makes the source-to-PDF transformation part of the
machine-readable contract. `latex-docker` is the preferred LaTeX profile. The
Buildchain paper scaffold and reusable workflow default to
`ghcr.io/kungfu-systems/build-images/latex-pdf-builder:v1.2.0`, pinned by the
digest above. The workflow pulls the declared image by digest and runs the
declared command in that pinned container. `custom-command` remains available
for compatibility, but the passport records it as lower trust because
Buildchain can record the command boundary without proving the compiler or
LaTeX distribution digest.

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
    uses: kungfu-systems/buildchain/.github/workflows/publication-artifact.yml@v2
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
- for `latex-docker`, pulls the pinned build-images LaTeX builder digest and
  runs the declared command in the container;
- for `custom-command`, runs the declared command and records the lower-trust
  boundary in the passport;
- runs the verify command;
- creates a source bundle from `publication.source_paths`;
- writes `.buildchain/publication/publication-artifact.json`;
- writes `.buildchain/publication/publication-artifact-passport.json`;
- when `[publication.archive]` is configured, writes
  `.buildchain/publication/publication-registry.json` and verifies same-version
  immutability;
- uploads one GitHub artifact containing the PDF, manifest, passport, optional
  registry, and source bundle.

It does not publish npm packages, deploy web pages, or create GitHub Releases.

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
    inputs:
      buildchain-ref:
        description: "Temporary Buildchain runtime ref"
        required: false
        default: ""

jobs:
  paper-release:
    uses: kungfu-systems/buildchain/.github/workflows/paper-release.yml@v2
    permissions:
      contents: write
      id-token: write
      issues: write
    with:
      buildchain-ref: ${{ inputs.buildchain-ref || '' }}
      toolchain-type: config
      verify-command: make check
      buildchain-contract-lock-path: .buildchain/contract-lock.json
```

The preset:

- resolves the same floating Buildchain runtime and contract lock as the build
  workflow;
- builds the PDF through the declared pinned LaTeX Docker toolchain or custom
  command;
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
- publishes the package through npm Trusted Publishing;
- writes Buildchain release/passport evidence; and
- creates or updates the exact-version GitHub Release by default.

Consumers can opt out of the GitHub Release with `github-release: false`, but
the default is on so downstream release propagation can observe
`release.published` without hand-written `gh release` steps.

For npm Trusted Publishing, register the consumer workflow file that calls this
preset, for example `.github/workflows/paper-release.yml`, against the declared
package in npm. The trusted publisher is the consumer repository and workflow
file; the implementation still runs inside Buildchain's reusable workflow.

Standard paper repositories should not carry local copies of
`scripts/npm-publish-transaction.mjs`, package-generation scripts, or
promotion/ref-lock YAML. If the default package shape is insufficient, extend
Buildchain rather than forking the mechanics into each paper repository.

## CLI And Node API

Generate the publication manifest locally or in CI:

```sh
buildchain publication-artifact manifest --source-sha "$(git rev-parse HEAD)" --json
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
