# README Badge Blocks

Buildchain can generate a managed README badge block from repository-owned
facts. The README keeps only a projection; the source facts remain in
`.buildchain/buildchain.toml`, package metadata, workflow files, KFD standards metadata,
and the repository's own release passport.

The managed block is delimited by:

```markdown
<!-- buildchain:badges:start -->
...
<!-- buildchain:badges:end -->
```

Buildchain owns only that block. Everything outside the markers remains normal
README content.

## Node API

Use the public package export:

```js
import {
  collectBadgeBundleFacts,
  collectReadmeBadgeFacts,
  createKfdBadgeSpecsFromStandards,
  renderBadgeBundleBlock,
  renderReadmeBadgeBlock,
  checkBadgeBundleBlock,
  checkReadmeBadgeBlock,
  updateBadgeBundleBlock,
  updateReadmeBadgeBlock,
} from "@kungfu-tech/buildchain/badges";
```

`@kungfu-tech/buildchain/readme-badges` remains available for compatibility,
but new integrations should use `@kungfu-tech/buildchain/badges`.

`collectReadmeBadgeFacts({ cwd })` returns a machine-readable object with
contract `kungfu-buildchain-readme-badge-facts`. It collects repository
identity, package name/version/license, configured platforms, configured
workflow status badges, the repository's own Buildchain Release Passport
location and verification result, and KFD badge state. KFD badge labels,
human-facing concept text, standard document links, schema IDs, and interface
contracts are read from
`@kungfu-tech/kfd/standards.json` when the package is installed, or from an
explicit `kfd_standards` path/URL. When present, it also summarizes local KFD
claim registry and product-mechanism facts from the package-owned site bundle,
so downstream agents can connect README badges back to Buildchain's
KFD/source-of-truth surfaces.

`renderReadmeBadgeBlock(facts)` renders deterministic Markdown from that facts
object. `checkReadmeBadgeBlock({ readmeText, facts })` compares the current
README marker block against the expected block and reports missing or stale
drift. `updateReadmeBadgeBlock({ readmeText, facts })` inserts or replaces the
managed block.

The Node API is the implementation source. The CLI delegates to it.

`collectBadgeBundleFacts({ cwd, claims })` is the trust-badge bundle API. It
uses the same repository facts, but returns contract
`kungfu-buildchain-badge-bundle-facts` and only renders the Buildchain trust
claims: every active `kfd-*` standard discovered from KFD standards metadata,
plus `release-passport`. KFD-1, KFD-2, KFD-3, KFD-4, and release passport are
enabled by default with current KFD metadata. Callers can pass
`claims: "kfd-1,release-passport"` or an array to narrow the bundle without
hand-writing badge Markdown.

## CLI

Generate facts as JSON:

```bash
buildchain badges readme --json
```

Fail closed when the README block is missing or stale:

```bash
buildchain badges readme --check
```

Insert or replace the block:

```bash
buildchain badges readme --write
```

Generate only the Buildchain trust badge bundle:

```bash
buildchain badges bundle --json
buildchain badges bundle --check
buildchain badges bundle --write
```

Narrow the bundle to specific claims:

```bash
buildchain badges bundle --claims kfd-1,release-passport --write
```

All commands accept `--cwd <dir>` and `--readme <path>`. Repositories can add
`buildchain badges bundle --check` or `buildchain badges readme --check` to CI
so badge drift is detected like any other generated release-facing surface.

## Configuration

The optional `[badges]` table in `.buildchain/buildchain.toml` declares local facts that
cannot be inferred safely:

```toml
[badges]
release_passport = "https://github.com/example/project/releases/latest/download/buildchain.release.json"
kfd_standards = "node_modules/@kungfu-tech/kfd/standards.json"
kfd_1 = "declared"
kfd_2 = "planned"
kfd_3 = "aligned"
kfd_4 = "declared"
platforms = ["macOS", "Linux", "Windows"]
workflows = ["verify.yml", "build.yml"]

[badges.bundle]
claims = ["kfd-1", "kfd-2", "kfd-3", "kfd-4", "release-passport"]
```

`release_passport` may be a local path or URL. If omitted, Buildchain tries
`buildchain.release.json`, then `.buildchain/release-passport/buildchain.release.json`,
then the repository's latest GitHub Release asset when the GitHub repository
can be discovered.

The generated `Buildchain Release Passport` badge is a repository capability
badge: it says whether the current repository has a Buildchain release passport
that can be verified. It does not report the upstream `kungfu-systems/buildchain`
repository status. Buildchain's own README dogfoods the same rule because its
configured `release_passport` points at Buildchain's own release passport.

Buildchain-owned badges use stable hosted image URLs by default:

```text
https://buildchain.libkungfu.dev/badges/v1/{badge}/{state}.svg
```

The URL is part of the Buildchain badge contract. Consumers do not need to
regenerate README files when Buildchain replaces the placeholder badge logo
with a formal logo; the hosted endpoint owns logo rendering. The package-owned
site bundle publishes `badge-endpoint-registry.json` plus Shields-compatible
JSON payloads under `badges/v1/**` so the site repository can serve or render
the exact SVG endpoints without inventing badge facts.

Forks or private deployments can override the image host with:

```toml
[badges]
badge_endpoint_base_url = "https://example.com/buildchain-badges/v1"
```

`kfd_standards` is optional. If omitted, Buildchain tries the installed
`@kungfu-tech/kfd/standards.json` package export. Use the explicit path or URL
only when a repository deliberately vendors KFD standards metadata or validates
against a local KFD development checkout. The KFD standards metadata controls
the badge vocabulary; the release passport still controls whether a repository
may display a KFD state as `passed`.

## KFD Badge Rules

KFD passed is evidence-backed. A repository may display `KFD-N passed` only when
its own release passport verifies successfully and the corresponding passport
section has `status: "passed"`. The KFD badge vocabulary comes from KFD
standards metadata, not Buildchain private strings: for example KFD-2 uses the
`releaseTrustPassport` concept and KFD-4 uses the `observerPerspective` concept
from `@kungfu-tech/kfd/standards.json`.

When no release passport exists yet, or when the passport cannot be verified,
Buildchain downgrades each KFD badge to the explicit local declaration such as
`declared`, `aligned`, or `planned`. A local `passed` declaration is treated as
`declared`; unknown local states are normalized to a non-passed fallback.

Buildchain's own README may link to Buildchain's own release passport. Other
repositories must not claim Buildchain's KFD status as their own; their badge
links must point to their own release passport or evidence page.

## CI Contract

Recommended CI gate:

```bash
buildchain badges readme --check
```

or, when the repository only wants the Buildchain trust bundle:

```bash
buildchain badges bundle --check
```

The check fails when:

- the marker block is missing;
- generated Markdown differs from repository facts;
- a previously hand-written KFD passed claim is not backed by the repository's
  verified release passport facts.

The machine-readable facts object should be used by downstream site renderers
or audit tools when Markdown badges are not enough.
