# Lifecycle Protocol

Buildchain uses `buildchain.toml` as the v1 repository configuration format.
The file is optional for simple JavaScript repositories, but it is the preferred
way to describe release version state and lifecycle commands when a project is
not a plain pnpm, npm, or yarn workspace.

Only TOML is supported in v1. YAML, JSON, and JavaScript config files are not
loaded.

## Minimal File

```toml
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.verify]
commands = [
  "pnpm run check",
]
```

`schema = 1` is required. Buildchain fails closed when the schema is missing or
unknown.

## Version State

Version state is the source file evidence that matches a release tag. During
promotion, Buildchain writes the selected release or prerelease version into the
configured files, verifies the resulting tree, creates a source version commit,
then moves exact and floating refs.

Supported version file types:

| Type | Use case | Required fields |
| --- | --- | --- |
| `json` | `package.json`, JSON manifests | `path`, `key` |
| `toml` | `pyproject.toml`, other TOML manifests | `path`, `key` |
| `regex` | `CMakeLists.txt`, `conanfile.py`, plain version files | `path`, `pattern`, `replacement` |

`key` is a dotted key path:

```toml
[[version.files]]
type = "toml"
path = "pyproject.toml"
key = "project.version"
```

Regex files must expose the current version through a named capture group called
`version`:

```toml
[[version.files]]
type = "regex"
path = "CMakeLists.txt"
pattern = 'project\([^)]* VERSION (?<version>[^ )]+)'
replacement = '${version}'
```

If `version.required = true`, promotion fails when no configured version files
are available.

### Anchored Manual Versions

Some repositories do not derive their package version from the Buildchain
release tag. `libnode` is the canonical example: the package version is anchored
to an explicitly selected upstream Node.js release such as `22.22.3-kf.0`, while
the channel line may be `release/v22/v22.22`.

Those repositories can opt into anchored manual semantics:

```toml
[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "libnode.release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"
```

With `strategy = "anchored"` and `next = "manual"`:

- Buildchain validates the configured version files and anchor manifest, but it
  does not rewrite those files to the Buildchain release tag.
- `lifecycle.verify` is the project-owned truth gate. It should compare the
  package version, anchor manifest, and upstream source/submodule state.
- release promotion still creates the exact/floating production refs for the
  current line;
- release promotion does not auto-create the next alpha branch or tag;
- the action output `next-anchor-required` is `true`, signaling that the next
  upstream anchor line must be created explicitly by the repository.

The configured anchor manifest must be JSON or TOML. Buildchain does not
interpret project-specific field names; it only loads the manifest and exposes
its top-level fields to validation summaries and lifecycle environment:

```text
BUILDCHAIN_VERSION_STRATEGY=anchored
BUILDCHAIN_VERSION_NEXT=manual
BUILDCHAIN_ANCHOR_MANIFEST=libnode.release.json
BUILDCHAIN_ANCHOR_MANIFEST_JSON={"nodeTag":"v22.22.3",...}
```

The upstream anchor decision remains outside Buildchain. A future line such as
`dev/v24/v24.xx` should be created by an explicit repository workflow or human
decision after the upstream version has been selected and checked in.

## Lifecycle Stages

Lifecycle stages are declarative shell commands. A stage can use exactly one of:

- `command`: one shell command;
- `commands`: multiple shell commands run in order;
- `script`: a multiline shell script.

Any command failure fails the stage. `timeout_minutes`, `retries`, `shell`, and
`env` can be attached to a stage.

During version-state verification, Buildchain also sets `BUILDCHAIN_VERSION` to
the release or prerelease version being verified.

```toml
[lifecycle.install]
timeout_minutes = 10
retries = 3
commands = [
  "pnpm install --frozen-lockfile",
]

[lifecycle.build]
commands = [
  "pnpm run build",
  "pnpm run package",
]

[lifecycle.verify]
shell = "bash"
script = """
set -euo pipefail
pnpm run check
git diff --check
"""
```

Shared environment variables can be declared once:

```toml
[lifecycle.env]
PYTHONUNBUFFERED = "1"
```

Stage-specific environment variables override shared lifecycle environment:

```toml
[lifecycle.test]
command = "pytest"

[lifecycle.test.env]
PYTHONPATH = "src"
```

## Promotion Semantics

`actions/promote-buildchain-ref` currently consumes `version.files` and
`lifecycle.verify`.

The verify stage runs after Buildchain has applied the generated version-state
changes to the local checkout, and before it creates release commits or moves
refs. After the command finishes, Buildchain checks that only declared
version-state files changed. This prevents verification from quietly adding
extra source changes to the release commit.

On protected alpha and release branches, the generated version-state commit is
merged through a normal pull request. This keeps review requirements,
conversation resolution, strict status checks, and admin enforcement intact.
After that PR lands, Buildchain verifies that the version-state PR changed only
declared version files from the legal channel-promotion parent before it moves
tags.

The action input `verification-command` remains supported. When it is provided,
it overrides `lifecycle.verify` for that invocation.

## Migration Preflight

Heavy repositories can validate their Buildchain declaration before they are
ready to run the real build. `actions/validate-config` checks that
`buildchain.toml` parses, configured version-state files exist, configured
version keys are strings, and required lifecycle stage names are declared.

It does not run lifecycle commands. This is useful for repositories such as
`libnode`, where `lifecycle.build` represents an expensive multi-platform native
build and the first migration milestone is to prove the release metadata and
lifecycle protocol without consuming build runners.

```yaml
- uses: kungfu-systems/buildchain/actions/validate-config@v1
  with:
    require-version-state: "true"
    require-lifecycle-stages: "install,build,verify"
```

## Examples

### Node Workspace

```toml
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.verify]
commands = [
  "pnpm run check",
]
```

### Python Package

```toml
schema = 1

[version]
required = true

[[version.files]]
type = "toml"
path = "pyproject.toml"
key = "project.version"

[lifecycle.install]
command = "python -m pip install -e .[test]"

[lifecycle.build]
command = "python -m build"

[lifecycle.verify]
commands = [
  "python -m build",
  "pytest",
]
```

### CMake and Conan

```toml
schema = 1

[[version.files]]
type = "regex"
path = "CMakeLists.txt"
pattern = 'project\([^)]* VERSION (?<version>[^ )]+)'
replacement = '${version}'

[lifecycle.configure]
commands = [
  "conan install . --build=missing",
  "cmake -S . -B build -DCMAKE_BUILD_TYPE=Release",
]

[lifecycle.build]
command = "cmake --build build --config Release"

[lifecycle.verify]
commands = [
  "cmake --build build --config Release",
  "ctest --test-dir build --output-on-failure",
]
```

### Docker Image

```toml
schema = 1

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.build]
command = "docker build -f Dockerfile -t kungfutrader/example:${BUILDCHAIN_VERSION} ."

[lifecycle.verify]
command = "docker build -f Dockerfile -t kungfutrader/example:verify ."
```

Docker publishing is an external side effect and should be gated by a release
workflow after version-state promotion has been verified.

## Design Boundaries

The lifecycle protocol is also the command source for the reusable build
surface. `.github/workflows/.build.yml` runs `lifecycle.install`,
`lifecycle.build`, and `lifecycle.verify` by default, while allowing callers to
override each stage with explicit workflow inputs. The underlying
`actions/run-lifecycle` action can be used directly by repositories that need a
custom workflow but still want Buildchain's lifecycle and deterministic manifest
contract.

Buildchain lifecycle commands are data, not executable configuration files.
They make release behavior reviewable in pull requests and keep the release
fact chain simple:

1. choose the channel branch and release line;
2. generate a source version commit from declared version files;
3. verify that exact tree;
4. move exact tags and floating refs only after verification succeeds;
5. run publish or deployment side effects in separately gated workflows.
