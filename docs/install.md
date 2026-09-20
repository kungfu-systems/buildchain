---
status: active
period: ongoing
theme: buildchain-installation
doc_type: technical-reference
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
  visible_context: Current CLI source and public v4.1.3 release asset names and SHA-256 digests.
  invisible_context_boundary: No new publication, installed artifact verification or live provider settlement is claimed.
---

# Install and Verify Buildchain

Buildchain can be consumed as a standalone binary, an npm package, or a
repository workflow surface. In every case, verify the release record before
adopting a new version.

## Standalone Binary

The [v4.1.3 release](https://github.com/kungfu-systems/buildchain/releases/tag/v4.1.3)
includes these standalone platform archives. The examples below pin that exact
release and verify its archive bytes against the published SHA-256 digests.

Use the archive that matches the platform:

| Platform | Asset |
| --- | --- |
| Linux x64 | `buildchain-x86_64-unknown-linux-gnu.tar.gz` |
| macOS arm64 | `buildchain-aarch64-apple-darwin.tar.gz` |
| Windows x64 | `buildchain-x86_64-pc-windows-msvc.zip` |

Linux example:

```bash
tag=v4.1.3
base="https://github.com/kungfu-systems/buildchain/releases/download/${tag}"
curl -fLO "${base}/buildchain-x86_64-unknown-linux-gnu.tar.gz"
echo 'd4240384f880f598df2a3ecd9220b3cd7ac4b7042ecb34f82c319cb76dfc8c1e  buildchain-x86_64-unknown-linux-gnu.tar.gz' | sha256sum --check &&
  tar -xzf buildchain-x86_64-unknown-linux-gnu.tar.gz &&
  ./buildchain version
```

Windows example:

```powershell
$tag = "v4.1.3"
$base = "https://github.com/kungfu-systems/buildchain/releases/download/$tag"
Invoke-WebRequest "$base/buildchain-x86_64-pc-windows-msvc.zip" -OutFile buildchain.zip
$digest = (Get-FileHash buildchain.zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($digest -ne "3ec4e2d9666d254e8a55fdbe99297d0884204cbd871dc399d8f6f791e824183f") { throw "Archive digest mismatch" }
Expand-Archive buildchain.zip -DestinationPath .
.\buildchain.exe version
```

The executable is inside each platform archive. The macOS archive's SHA-256
for v4.1.3 is `79221431aa832053952bffb36e68d63676ec922fc317d6f7e315d32a2fd20993`;
use `shasum -a 256` to check it. Select a release and its matching digests together.

## npm Package

```bash
npm install -D @kungfu-tech/buildchain
npx buildchain version
npx buildchain doctor --json
```

The highest alpha minor publishes to the `alpha` npm dist-tag; older maintenance
minor alphas use `vX.Y-alpha` so they cannot roll the global alpha channel back.
Stable releases publish to
`latest`. Both are created by the protected Buildchain promotion transaction.

Stable consumers should pin the exact Buildchain version they have validated,
for example:

```bash
pnpm add -D @kungfu-tech/buildchain@4.1.3
```

If a repository dogfoods a just-published Buildchain version and pnpm's release
age policy blocks the install, use a temporary package/version-specific
`minimumReleaseAgeExclude` entry instead of weakening the registry policy for
all packages:

```yaml
minimumReleaseAgeExclude:
  - '@kungfu-tech/buildchain@4.1.3'
```

Remove that entry after the package is old enough for the repository's normal
policy. Do not use a broad exclude such as `@kungfu-tech/*` for this case.
For repositories that already have `pnpm-workspace.yaml`, Paper migration
maintains the exclusion for the selected exact Buildchain version.

## Repository Integration

```bash
npx @kungfu-tech/buildchain init --type package --package-manager pnpm
npx @kungfu-tech/buildchain validate --require-version-state
npx @kungfu-tech/buildchain doctor --json
```

Use `.buildchain/buildchain.toml` to declare schema-2 products and their install,
build and verification commands. The generated `buildchain.yml` and
`buildchain-recover.yml` delegate normal operation and exact-attempt recovery
to the shared public pair. A protected channel PR expresses release intent;
the runtime owns publication. See the [getting-started guide](getting-started.md).

## Release Evidence

Current pipeline releases retain `buildchain.release.json` using
`kungfu.buildchain.release-passport/v4`, alongside plan, qualification,
invocation, capsule and attestation JSON files. Their checks and provider
readback belong to the shared pipeline. v4.1.3 publishes this inventory on its
release page.

Use a CLI built from the current source for the v4 reader; the published 4.1.3
CLI still has the legacy-only reader. Keep all six evidence files together,
unchanged, and install GitHub CLI with `gh attestation verify` support:

```bash
gh release download v4.1.3 --repo kungfu-systems/buildchain --pattern 'buildchain.*.json'
buildchain verify release-passport buildchain.release.json --json
buildchain explain release --passport buildchain.release.json --for agent --json
```

The current reader verifies the central publisher's attestation, exact source,
qualification, invocation, capsules and reconstructed passport. Its report uses
`verificationScope: signed-release-metadata`; this does not check downloaded
archive bytes or reobserve the provider's current publication state. Check the
archive's digest separately before extracting or running it.

Missing or changed companion evidence, an unexpected publisher, or a failed
signature check produces a failed verification report. The reader also retains
support for the legacy `kungfu-buildchain-release-passport` envelope and its
original sibling evidence files.
