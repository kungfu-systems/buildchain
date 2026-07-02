# Buildchain

Buildchain Release Passport is a mature product release record for artifacts
that users or agents depend on.

Buildchain by Kungfu uses GitHub as the execution and trust substrate: protected
refs, reviewed promotion PRs, exact tags, GitHub Releases, npm Trusted
Publishing, and machine-readable evidence. Its job is to turn release intent
into an auditable product record, not to ask a repository to migrate away from
its existing CI.

The same mechanism releases Buildchain itself.

## Install and Verify

For standalone use, install a platform archive from a GitHub Release and verify
the release passport before trusting the binary:

```bash
# Example for Linux x64. Use the archive that matches your platform.
curl -LO https://github.com/kungfu-systems/buildchain/releases/download/v2.2.1/buildchain-x86_64-unknown-linux-gnu.tar.gz
curl -LO https://github.com/kungfu-systems/buildchain/releases/download/v2.2.1/buildchain.release.json
curl -LO https://github.com/kungfu-systems/buildchain/releases/download/v2.2.1/artifact-evidence.json
npx @kungfu-tech/buildchain verify release-passport buildchain.release.json
tar -xzf buildchain-x86_64-unknown-linux-gnu.tar.gz
./buildchain version
```

Release pages publish platform archives, checksums, release passport files, and
a single evidence bundle:

- `buildchain-x86_64-unknown-linux-gnu.tar.gz`
- `buildchain-aarch64-apple-darwin.tar.gz`
- `buildchain-x86_64-pc-windows-msvc.zip`
- `checksums.txt`
- `buildchain.release.json`
- `artifact-evidence.json`
- `product-mechanism.json`
- `impact.json`
- `agent-index.json`
- `check-report.json`
- `llms.txt`
- `buildchain-release-bundle.tar.gz`
- `buildchain-release-bundle.json`

Loose top-level `buildchain` and `buildchain.exe` assets are intentionally not
published. The executable lives inside each platform archive, which prevents
Linux and macOS artifacts from overwriting each other in a merged release lane.

For npm consumers:

```bash
npm install -D @kungfu-tech/buildchain
npx buildchain version
npx buildchain doctor --json
```

The npm package exposes the `buildchain` command and importable toolkit APIs:

```js
import { createBuildchainLogger } from "@kungfu-tech/buildchain/logging";
import { verifyReleasePassport } from "@kungfu-tech/buildchain/release-passport";
```

The package also ships `dist/site/` as the Buildchain-owned fact source for
`buildchain.libkungfu.dev`.

## Use Buildchain

Bootstrap a repository:

```bash
npx @kungfu-tech/buildchain init --type package --package-manager pnpm
npx @kungfu-tech/buildchain validate --require-version-state
npx @kungfu-tech/buildchain release --dry-run --target-ref alpha/v2/v2.2
```

Buildchain supports package and non-package projects through `buildchain.toml`.
Lifecycle commands can call pnpm, npm, yarn, pip, Conan, CMake, Make, custom
scripts, or any other command that can run in the repository checkout.

Buildchain's active GitHub Action surface is deliberately small:

- `actions/validate-config`
- `actions/run-lifecycle`
- `actions/promote-buildchain-ref`

The active reusable workflow surfaces are:

- `.github/workflows/.build.yml` for deterministic multi-platform build and
  artifact contracts;
- `.github/workflows/.web-surface.yml` for preview, staging, production, and
  cleanup plans for site/app repositories;
- `.github/workflows/buildchain-ref-promotion.yml` for protected release
  promotion and version-state transactions;
- `.github/workflows/binary-distribution.yml` for Buildchain's own release
  passport proof case.

Stable consumers should reference actions and workflows through floating major
refs after reviewing the exact release passport:

```yaml
uses: kungfu-systems/buildchain/actions/validate-config@v2
```

```yaml
uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
```

## Release Model

Buildchain treats a reviewed branch merge as release intent:

| Merge path | Meaning | Exact tag | Floating refs |
| --- | --- | --- | --- |
| `dev/vX/vX.Y -> alpha/vX/vX.Y` | publish the next testable alpha for a minor line | `vX.Y.Z-alpha.N` | `vX.Y-alpha`, `alpha/vX/vX.Y`, `dev/vX/vX.Y` |
| `alpha/vX/vX.Y -> release/vX/vX.Y` | publish production for that minor line | `vX.Y.Z` | `vX.Y`, usually `vX`, `release/vX/vX.Y` |
| `release/vX/vX.Y -> publish-gate/major` | publish the next major from a reviewed production line | `v(X+1).0.0` | `v(X+1)`, `v(X+1).0`, new dev/alpha/release branches |

Exact tags are immutable. Floating channel tags and branches are machine-updated
by Buildchain and must remain writable by the release authority.

After a production release, Buildchain prepares the next alpha source commit for
the same minor line. That keeps production consumers pinned to the production
passport while development can continue on the next testable patch.

`publish-gate/major` is not an active development trunk. It is a reviewed
promotion gate used when maintainers decide that the next production release
should open a new major line.

## Toolkit Observability

Buildchain includes a logging toolkit for release and build steps:

```bash
buildchain mark --event native.configure --phase configure --component cmake
buildchain span --event native.build --phase build -- cmake --build build
buildchain log summary --json
buildchain verify observability-log .buildchain/logs/events.jsonl --min-events 4
```

Every event records a timestamp. `span` records duration. The API form can be
imported from repository scripts so heavy builds can mark phases from inside
their own code.

## Site Fact Source

`@kungfu-tech/buildchain` publishes `dist/site/`:

- `buildchain-site.json`
- `site-manifest.json`
- `cli-registry.json`
- `workflow-registry.json`
- `release-model.json`
- `artifact-schemas.json`
- `product-mechanism.json`
- `release-provenance.json`
- `agent-index.json`

`buildchain.libkungfu.dev` should render from these package-owned facts, then
layer presentation around them. The site should not hand-write Buildchain's
current release mechanics.

## Local Verification

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run generate:site
pnpm run check
npm pack --dry-run --json --registry=https://registry.npmjs.org/
```

## Read Next

- [Install and verify](docs/install.md)
- [Documentation map](docs/MAP.md)
- [Product mechanism](docs/product-mechanism.md)
- [Release Passport and binary distribution](docs/release-passport.md)
- [Binary distribution details](docs/binary-distribution.md)
- [Toolkit observability](docs/toolkit-observability.md)
- [Site bundle contract](docs/site-bundle-contract.md)
- [Lifecycle protocol](docs/lifecycle-protocol.md)
- [Reusable build surface](docs/reusable-build-surface.md)
- [Publish transaction](docs/publish-transaction.md)
- [Release governance](docs/release-governance.md)
