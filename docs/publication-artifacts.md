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

## Reusable Workflow

Consumer repositories can call the Buildchain wrapper directly:

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

The workflow:

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

The wrapper is build-only. It does not publish npm packages, deploy web pages,
or create GitHub Releases. Release publication can be layered later by a
repository-specific governance workflow that attaches the generated manifest
and passport as release assets.

## CLI And Node API

Generate the publication manifest locally or in CI:

```sh
buildchain publication-artifact manifest --source-sha "$(git rev-parse HEAD)" --json
```

Node API:

```js
import {
  collectPublicationArtifact,
  writePublicationArtifact,
} from "@kungfu-tech/buildchain/publication-artifact";
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
