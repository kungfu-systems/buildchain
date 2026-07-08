# Build Facts

Build Facts are Buildchain's machine-readable record of what a repository
built. They sit between lifecycle logs and release passports:

- lifecycle logs explain what ran and how long it took;
- module build facts bind one module to its Git source digest, version source,
  platform, lifecycle invocation, and output digests;
- product build facts aggregate module facts and product artifacts;
- release passports can carry build facts as first-class evidence.

The goal is to remove handwritten build metadata from consumer repositories.
Consumers declare where their version and outputs live; Buildchain collects and
verifies the facts.

## Config

Declare build facts in `buildchain.toml`:

```toml
schema = 1

[[facts.version_sources]]
id = "package"
type = "json"
path = "package.json"
key = "version"

[[facts.modules]]
id = "native-core"
root = "src/core"
scope = "core"
version_source = "package"
lifecycle = "build"
outputs = ["dist/core.node"]

[[facts.products]]
id = "kungfu"
module_facts = [".buildchain/facts/native-core.json"]
artifacts = ["dist/kungfu.zip"]

[[facts.legacy_projections]]
type = "kungfu-buildinfo"
module = "native-core"
path = "framework/core/src/kungfu/yijinjing/kungfubuildinfo.json"
```

Supported version sources:

- `static`: an explicit `value`;
- `json`: a JSON file plus dotted `key`;
- `toml`: a TOML file plus dotted `key`;
- `regex`: a text file plus regex `pattern`, using a named `version` group or
  the first capture group;
- `command`: an explicit command whose output is the version.

Prefer file-based sources. Command sources are allowed for legacy projects but
are marked as less reproducible because the command output is not a static
source file.

## CLI

Collect a module fact:

```bash
buildchain facts module \
  --module native-core \
  --output .buildchain/facts/native-core.json
```

Override declarative config from a workflow step when needed:

```bash
buildchain facts module \
  --cwd "$GITHUB_WORKSPACE" \
  --module native-core \
  --module-root src/core \
  --version-source package \
  --output-path dist/core.node \
  --output .buildchain/facts/native-core.json \
  --json
```

Write the Kungfu legacy `kungfubuildinfo.json` projection from the same module
fact:

```bash
buildchain facts module \
  --module native-core \
  --output .buildchain/facts/native-core.json \
  --legacy-kungfu-buildinfo framework/core/src/kungfu/yijinjing/kungfubuildinfo.json
```

Aggregate product facts:

```bash
buildchain facts aggregate \
  --product kungfu \
  --module-fact .buildchain/facts/native-core.json \
  --artifact dist/kungfu.zip \
  --output .buildchain/facts/kungfu.json
```

Verify a fact before publishing:

```bash
buildchain facts verify --fact .buildchain/facts/kungfu.json
```

Verification fails closed when a declared output is missing, an output digest is
stale, a module fact was collected from a different Git `HEAD`, or a source
digest no longer matches the tracked source files.

## Node API

```js
import {
  aggregateBuildFacts,
  collectModuleBuildFacts,
  verifyBuildFacts,
  writeBuildFacts,
  writeKungfuBuildInfoProjection,
} from "@kungfu-tech/buildchain/build-facts";

const moduleFact = collectModuleBuildFacts({ moduleId: "native-core" });
writeBuildFacts({ fact: moduleFact, output: ".buildchain/facts/native-core.json" });

const productFact = aggregateBuildFacts({ productId: "kungfu" });
const verification = verifyBuildFacts({ fact: productFact });
```

The root package export also re-exports these APIs from
`@kungfu-tech/buildchain`.

## Release Passport Integration

Pass build facts into a release passport:

```bash
buildchain collect github-release \
  --tag "$TAG" \
  --assets-dir dist \
  --build-facts-json .buildchain/facts/native-core.json \
  --build-facts-json .buildchain/facts/kungfu.json \
  --output-dir .buildchain/release-passport
```

The passport records the full build facts in `buildFacts[]` and a compact
evidence index in `evidence.buildFacts[]`. Agents can start from
`buildchain.release.json`, discover the module/product facts, and verify that
the released artifacts still match the declared source, version, and output
facts.

## Kungfu Legacy Projection

Kungfu historically consumes `kungfubuildinfo.json`. Buildchain now treats that
file as a projection of module build facts, not as an independent source of
truth. The projection preserves legacy fields such as `version`,
`python_version`, `git_branch`, `git_revision`, and `git_pristine`, while adding
a `buildchain` section that points back to the module fact digest, version
source digest, and source digest.

Repositories that no longer need the legacy file should consume the module and
product facts directly.
