# Install and Verify Buildchain

Buildchain can be consumed as a standalone binary, an npm package, or a
repository workflow surface. In every case, verify the release record before
adopting a new version.

## Standalone Binary

Use the archive that matches the platform:

| Platform | Asset |
| --- | --- |
| Linux x64 | `buildchain-x86_64-unknown-linux-gnu.tar.gz` |
| macOS arm64 | `buildchain-aarch64-apple-darwin.tar.gz` |
| Windows x64 | `buildchain-x86_64-pc-windows-msvc.zip` |

Linux example:

```bash
tag=v2.2.1
base="https://github.com/kungfu-systems/buildchain/releases/download/${tag}"
curl -LO "${base}/buildchain-x86_64-unknown-linux-gnu.tar.gz"
curl -LO "${base}/buildchain.release.json"
curl -LO "${base}/artifact-evidence.json"
npx @kungfu-tech/buildchain verify release-passport buildchain.release.json
tar -xzf buildchain-x86_64-unknown-linux-gnu.tar.gz
./buildchain version
```

Windows example:

```powershell
$tag = "v2.2.1"
$base = "https://github.com/kungfu-systems/buildchain/releases/download/$tag"
Invoke-WebRequest "$base/buildchain-x86_64-pc-windows-msvc.zip" -OutFile buildchain.zip
Invoke-WebRequest "$base/buildchain.release.json" -OutFile buildchain.release.json
Invoke-WebRequest "$base/artifact-evidence.json" -OutFile artifact-evidence.json
npx @kungfu-tech/buildchain verify release-passport buildchain.release.json
Expand-Archive buildchain.zip -DestinationPath .
.\buildchain.exe version
```

The GitHub Release page does not publish loose top-level `buildchain` or
`buildchain.exe` files. The executable is inside each platform archive.

## npm Package

```bash
npm install -D @kungfu-tech/buildchain
npx buildchain version
npx buildchain doctor --json
```

Alpha releases publish to the `alpha` npm dist-tag. Stable releases publish to
`latest`. Both are created by the protected Buildchain promotion transaction.

## Repository Integration

```bash
npx @kungfu-tech/buildchain init --type package --package-manager pnpm
npx @kungfu-tech/buildchain validate --require-version-state
npx @kungfu-tech/buildchain release --dry-run --target-ref alpha/v2/v2.2
```

Use `buildchain.toml` to declare lifecycle commands. The commands may use Node
package managers or non-Node tools such as pip, Conan, CMake, Make, or project
scripts.

## Verify a Release Passport

```bash
buildchain verify release-passport buildchain.release.json
buildchain explain release --passport buildchain.release.json --for agent --json
```

The verifier fails closed when the passport or its sibling evidence files are
missing required fields or mismatching artifact digests.

