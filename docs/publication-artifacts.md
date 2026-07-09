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
primary_artifact = "_build/main.pdf"
artifact_paths = ["_build/main.pdf"]
metadata_paths = ["README.md", "docs/MAP.md"]
source_paths = ["paper", "README.md", "LICENSE", "Makefile"]
site_consumers = ["papers.libkungfu.dev"]
manifest_path = ".buildchain/publication/publication-artifact.json"
source_bundle_path = ".buildchain/publication/source.tar.gz"

[publication.toolchain]
type = "latex-docker"
image = "ghcr.io/kungfu-systems/latex"
digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
command = "latexmk -pdf -outdir=_build paper/main.tex"

[lifecycle.build]
command = "make pdf"

[lifecycle.verify]
command = "make check"
```

`primary_artifact` is the human-facing publication output, usually a PDF.
`source_paths` are archived into a source bundle. `metadata_paths` are hashed
and recorded so a site can consume the paper facts without scraping prose.

`publication.toolchain` makes the source-to-PDF transformation part of the
machine-readable contract. `latex-docker` is the preferred LaTeX profile: the
workflow pulls the declared image by digest and runs the declared command in
that pinned container. `custom-command` remains available for compatibility,
but the passport records it as lower trust because Buildchain can record the
command boundary without proving the compiler or LaTeX distribution digest.

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
- for `latex-docker`, pulls the pinned image digest and runs the declared
  command in the container;
- for `custom-command`, runs the declared command and records the lower-trust
  boundary in the passport;
- runs the verify command;
- creates a source bundle from `publication.source_paths`;
- writes `.buildchain/publication/publication-artifact.json`;
- writes `.buildchain/publication/publication-artifact-passport.json`;
- uploads one GitHub artifact containing the PDF, manifest, passport, and
  source bundle.

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
- downstream site-consumption hints.

The companion publication artifact passport records the same source and
artifact evidence plus an explicit responsibility split. Buildchain proves
declared files and hashes; it does not peer-review paper claims.

## Site Consumption

A downstream papers site should treat the publication manifest as the single
fact source for the artifact. The site owns rendering and navigation; it should
not reinterpret the paper repository as a web deployment source.

For `paper-observer-declared-timelines`, the expected adoption path is:

```text
paper repo builds PDF + manifest + source bundle
papers site consumes publication-artifact.json
site renders paper page and links the PDF/source bundle
```

This mirrors web-surface governance without mixing producer and renderer
responsibilities.
