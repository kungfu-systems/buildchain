# Binary Distribution

Buildchain's binary distribution is the first high-pressure proof case for the
Release Passport protocol. It is not the boundary of the product.

## Asset Rules

GitHub Release assets use platform-specific archives:

- `buildchain-x86_64-unknown-linux-gnu.tar.gz`
- `buildchain-aarch64-apple-darwin.tar.gz`
- `buildchain-x86_64-pc-windows-msvc.zip`

The release lane does not upload loose top-level `buildchain` or
`buildchain.exe` assets. Linux and macOS both name the executable `buildchain`
inside their archives, so top-level loose assets would collide when matrix
artifacts are merged.

Release asset upload is gated before the matrix starts. Manual
`workflow_dispatch` runs are binary dry-runs only and must keep
`upload-release=false`; real GitHub Release uploads must come from a true
`v*` tag-triggered run so an invalid manual upload request cannot spend the
three-platform build matrix and then fail at `gh release upload`.

Each archive is accompanied by:

- a platform manifest from the standalone binary builder;
- platform observability event logs and summaries;
- `checksums.txt`;
- Release Passport evidence files;
- `buildchain-release-bundle.tar.gz`;
- `buildchain-release-bundle.json`.

## Runner Policy

Production binary builds use GitHub-hosted runners:

- `ubuntu-24.04`
- `macos-latest`
- `windows-2022`

Self-hosted runners are compatibility fixtures. They can prove that consumers
with private runner fleets can still use the protocol, but Buildchain's public
binary distribution should stay reproducible on GitHub-hosted runners.

## Evidence Bundle

`buildchain-release-bundle.tar.gz` groups release assets and passport evidence
under one archive:

```text
buildchain-release-bundle/
  release-assets/
  release-passport/
  buildchain-release-bundle.index.json
```

`buildchain-release-bundle.json` records the bundle digest and every included
file digest. Consumers can download the bundle when they want one artifact for
offline review, mirroring, or site ingestion.

## Local Smoke

```bash
node scripts/build-standalone-binary.mjs --version v0.0.0-local --output-dir dist/binary
node bin/buildchain.mjs collect github-release \
  --tag v0.0.0-local \
  --assets-dir dist/binary \
  --output-dir .buildchain/release-passport
node scripts/create-release-bundle.mjs \
  --assets-dir dist/binary \
  --passport-dir .buildchain/release-passport \
  --output-dir .buildchain/release-passport \
  --tag v0.0.0-local
```
