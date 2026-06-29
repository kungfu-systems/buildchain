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

Buildchain lifecycle commands are data, not executable configuration files.
They make release behavior reviewable in pull requests and keep the release
fact chain simple:

1. choose the channel branch and release line;
2. generate a source version commit from declared version files;
3. verify that exact tree;
4. move exact tags and floating refs only after verification succeeds;
5. run publish or deployment side effects in separately gated workflows.
