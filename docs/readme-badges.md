# README Badge Blocks

Buildchain can generate a managed README badge block from repository-owned
facts. The README keeps only a projection; the source facts remain in
`buildchain.toml`, package metadata, workflow files, and the repository's own
release passport.

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
  collectReadmeBadgeFacts,
  renderReadmeBadgeBlock,
  checkReadmeBadgeBlock,
  updateReadmeBadgeBlock,
} from "@kungfu-tech/buildchain/readme-badges";
```

`collectReadmeBadgeFacts({ cwd })` returns a machine-readable object with
contract `kungfu-buildchain-readme-badge-facts`. It collects repository
identity, package name/version/license, configured platforms, configured
workflow status badges, release passport location and verification result, and
KFD badge state. When present, it also summarizes local KFD claim registry and
product-mechanism facts from the package-owned site bundle, so downstream
agents can connect README badges back to Buildchain's KFD/source-of-truth
surfaces.

`renderReadmeBadgeBlock(facts)` renders deterministic Markdown from that facts
object. `checkReadmeBadgeBlock({ readmeText, facts })` compares the current
README marker block against the expected block and reports missing or stale
drift. `updateReadmeBadgeBlock({ readmeText, facts })` inserts or replaces the
managed block.

The Node API is the implementation source. The CLI delegates to it.

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

All commands accept `--cwd <dir>` and `--readme <path>`. Repositories can add
`buildchain badges readme --check` to CI so badge drift is detected like any
other generated release-facing surface.

## Configuration

The optional `[badges]` table in `buildchain.toml` declares local facts that
cannot be inferred safely:

```toml
[badges]
release_passport = "https://github.com/example/project/releases/latest/download/buildchain.release.json"
kfd_1 = "declared"
kfd_2 = "planned"
kfd_3 = "aligned"
platforms = ["macOS", "Linux", "Windows"]
workflows = ["verify.yml", "build.yml"]
```

`release_passport` may be a local path or URL. If omitted, Buildchain tries
`buildchain.release.json`, then `.buildchain/release-passport/buildchain.release.json`,
then the repository's latest GitHub Release asset when the GitHub repository
can be discovered.

## KFD Badge Rules

KFD passed is evidence-backed. A repository may display `KFD-1 passed`,
`KFD-2 passed`, or `KFD-3 passed` only when its own release passport verifies
successfully and the corresponding passport section has `status: "passed"`.

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

The check fails when:

- the marker block is missing;
- generated Markdown differs from repository facts;
- a previously hand-written KFD passed claim is not backed by the repository's
  verified release passport facts.

The machine-readable facts object should be used by downstream site renderers
or audit tools when Markdown badges are not enough.
