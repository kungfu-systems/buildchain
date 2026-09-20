---
status: draft
period: ongoing
theme: paper-consumer
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
  visible_context: Schema-2 product compiler, shared caller templates and Paper source scaffold.
  invisible_context_boundary: No downstream repository migration or hosted Paper release is claimed.
---

# Paper products

A Paper repository owns its source, build commands, verification commands and
PDF output. It uses the same two Buildchain caller files as npm and binary
products. The published pipeline owns delivery, publication and recovery.

## Create or adopt a source tree

For an existing paper with working `make pdf` and `make check` commands:

```sh
buildchain init --type paper
buildchain validate --require-lifecycle-stages build,verify
```

To generate a new LaTeX source tree, inspect the plan and then write it:

```sh
buildchain paper scaffold --name paper-example --title "Example Paper" \
  --repository example/paper-example --json
buildchain paper scaffold --name paper-example --title "Example Paper" \
  --repository example/paper-example --write --json
```

The scaffold contains the paper, bibliography, Makefile, license, product
manifest, documentation, schema-2 TOML and shared caller pair. It creates no
repository-side provisioning authority, agent-entry JSON or release controller.
Existing conflicting files, extra workflows and symlinked write parents stop
writing before another planned file is created. Repeating an unchanged plan is
idempotent.

The new Makefile builds LaTeX in a digest-pinned container with networking
disabled for the build. Running it requires Docker and the referenced image.
`make check` checks the source files and Git whitespace; add product-specific
content and PDF checks there as needed. A single successful build is not a
proof of reproducibility across independent builds.

## Product configuration

The generated `.buildchain/buildchain.toml` includes a Paper product:

```toml
[[products]]
id = "main"
type = "paper"
platforms = ["linux-x64"]
build = ["make pdf"]
verify = ["make check"]

[[products.artifacts]]
id = "main"
path = "_build/main.pdf"
kind = "pdf"

[[products.targets]]
provider = "github-release"
artifacts = ["main"]
```

This is the product portion of the generated configuration. Keep its schema,
version, channels and protected-review policy sections as well. Product commands
may change with the source tree; the two caller files remain identical across
product types:

- `.github/workflows/buildchain.yml` calls the common normal pipeline.
- `.github/workflows/buildchain-recover.yml` calls exact-attempt recovery.

The source package is private. Its `version` is the product version authority;
its description and optional homepage retain the paper's title and site URL.
`--package` optionally sets this source identity and does not add an npm target.
When adopting a source tree without a versioned package manifest, `init` creates
`release.json` as the version authority instead.

## Validate and publish

```sh
make pdf
make check
buildchain validate --require-lifecycle-stages build,verify
buildchain paper preflight --json
buildchain paper status --json
```

For schema-2 Paper repositories, preflight and status check local product policy
and exact caller bytes. They return `localOnly: true` and
`publication.status: "not-observed"`. They do not contact npm or GitHub accounts,
and their success does not prove hosted admission, a successful build or a
published release.

Open a PR on the configured protected channel route to request delivery or
publication. Supply the common repository permissions and tool-maintained
runtime locks required by the published entry. Recover a failed operation using
its exact attempt identifier in the shared recovery workflow. An optional
repaired runtime applies to that recovery; do not persist it in product callers.

## Existing papers and downstream sites

The former schema-1 npm-paper scaffold used separate product workflows and
repository-side control records. It is no longer generated for new papers.
Moving an existing paper to this contract changes its publication target to PDF
assets in GitHub Releases. Review that target change and downstream consumption
before migrating an existing repository; `init --force` does not absorb old
workflows or silently convert their product behavior.

`buildchain paper migrate --json` plans the conversion from a clean committed
source. It retains declared build/verification commands, moves publication
metadata into `paper/publication-metadata.json`, and makes the private source
package's version authoritative. `--write` applies the reviewed changes and
removes only recognized legacy callers and digest-checked controller files.
Custom workflows, conflicting version authorities, extra configuration sections,
and unrepresentable lifecycle settings fail before writing. Runtime locks and
historical receipts remain byte-identical; channel-root overrides are retired.
A later source change invalidates the plan. Refresh the dependency lockfile if
the plan updates an optional local Buildchain CLI dependency.

Keep already published npm versions, original PDF bytes and retained publication
receipts as historical evidence. A new local configuration does not rewrite or
requalify those releases. Existing append-only archives retain their immutability
rules. Sites own rendering, navigation and archive import; they must consume the
actual selected release and its evidence rather than infer a new npm publication
from a Paper configuration or successful local check.

## Retired Paper execution commands

The schema-2 Paper interface no longer exposes `paper bootstrap npm`,
`paper build`, `paper alpha`, or `paper resume`. These commands depended on
legacy publication configuration and separate workflow wiring. Use the product
build/verification commands declared in TOML, a legal channel PR to request
publication, and the generated recovery caller with an exact attempt. The
generic product reproducibility tools remain available; this change does not
rewrite published artifacts or historical receipts. Legacy status/preflight
readers direct users to the migration preview.
