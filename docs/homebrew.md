# Homebrew Distribution Indexes

Buildchain treats a Homebrew tap as a distribution-index project: the tap
contains Formula or Cask files, but those files are projections of upstream
release passports. Version, download URLs, SHA-256 digests, KFD status, and
evidence links come from the upstream product release, not from hand-maintained
tap prose.

## Configuration

Use `project.type = "distribution-index"` for tap repositories:

```toml
schema = 1

[project]
type = "distribution-index"
name = "homebrew-tap"

[lifecycle.verify]
command = "buildchain homebrew check"
```

The tap manifest is the repository-owned declaration of which upstream releases
are indexed. Buildchain writes `tap-manifest.json` as a machine-readable
projection:

```json
{
  "schema": 1,
  "contract": "kungfu-buildchain-homebrew-tap-manifest",
  "kind": "homebrew-tap",
  "entries": [
    {
      "type": "formula",
      "name": "buildchain",
      "path": "Formula/buildchain.rb",
      "upstream": {
        "repository": "kungfu-systems/buildchain",
        "tag": "v2.8.15",
        "releasePassportUrl": "https://github.com/kungfu-systems/buildchain/releases/download/v2.8.15/buildchain.release.json"
      },
      "version": "2.8.15",
      "kfd": {
        "kfd-1": "passed",
        "kfd-2": "passed",
        "kfd-3": "passed"
      },
      "artifacts": [
        {
          "platform": "darwin-arm64",
          "url": "https://github.com/kungfu-systems/buildchain/releases/download/v2.8.15/buildchain-aarch64-apple-darwin.tar.gz",
          "sha256": "..."
        }
      ]
    }
  ]
}
```

## CLI

Update a formula and manifest from an upstream passport:

```bash
buildchain homebrew update-formula \
  --package buildchain \
  --release-passport https://github.com/kungfu-systems/buildchain/releases/download/v2.8.15/buildchain.release.json \
  --write
```

Check that the tap still matches upstream evidence:

```bash
buildchain homebrew check --json
```

`check` fails closed when:

- the upstream release passport or its sibling evidence does not verify;
- `Formula/buildchain.rb` drifts from the projected version, URLs, or SHA-256
  digests;
- `tap-manifest.json` drifts from the projected upstream evidence;
- the tap claims KFD-1, KFD-2, or KFD-3 passed without a verified upstream
  passport section.

## Node API

Use the public `@kungfu-tech/buildchain/homebrew` export:

```js
import {
  collectHomebrewTapFacts,
  renderHomebrewFormula,
  checkHomebrewTap,
  updateHomebrewTap,
} from "@kungfu-tech/buildchain/homebrew";
```

The API is the single implementation source. The CLI is a thin wrapper over
these functions, so CI and local update commands evaluate the same facts.

## Trust Model

Formula metadata is not source of truth. A tap entry may claim `kfd-1`,
`kfd-2`, or `kfd-3` passed only when the upstream release passport verifies and
the corresponding passport section is `status = "passed"`. If verification
fails, Buildchain downgrades the projected KFD status to `unverified` and
`buildchain homebrew check` fails.

In short: KFD passed in a tap means the upstream release passport passed, not
that the tap author typed a passing status.

This makes Homebrew taps suitable for automated distribution-index CI: the tap
can move quickly while still proving that every download URL and digest is
bound to release passport evidence.
