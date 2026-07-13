# Lifecycle Protocol

Buildchain uses `.buildchain/buildchain.toml` as the v2 repository configuration format.
The file is optional for simple JavaScript repositories, but it is the preferred
way to describe release version state and lifecycle commands when a project is
not a plain pnpm, npm, or yarn workspace.

For compatibility, Buildchain still reads a legacy root `buildchain.toml` when
`.buildchain/buildchain.toml` is absent. New repositories should use the
`.buildchain/` layout so all Buildchain-owned local state lives under one
directory.

Only TOML is supported in v2. YAML, JSON, and JavaScript config files are not
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

Configured JSON and TOML version files are semantic no-ops when the declared
key already equals the requested version. Buildchain preserves the repository's
original TOML bytes in that case instead of serializing the whole document and
creating formatter-only release state. When a TOML version really changes,
Buildchain applies a parser-verified lossless edit to that key and fails closed
if it cannot prove a unique edit; unrelated arrays, comments, and formatting
remain repository-owned.

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

[lifecycle.check]
command = "pnpm run check:source"

[lifecycle.verify]
shell = "bash"
script = """
set -euo pipefail
pnpm run check
git diff --check
"""
```

`lifecycle.check` is the repository-owned source-acceptance gate. It should
validate the checked-out source revision without entering the build, artifact,
or release lifecycle. Consumers can run it on GitHub-hosted Linux through
`.github/workflows/check.yml@v2` with `mode: source`; the reusable workflow runs
only `lifecycle.install` and `lifecycle.check`. The default `mode: verify`
continues to run `lifecycle.install` and `lifecycle.verify` for existing callers.
Both executed stages receive `BUILDCHAIN_CHECK_MODE=source` or
`BUILDCHAIN_CHECK_MODE=verify`, so a repository whose normal install path can
compile native tooling can select a provisioning-only install path for source
acceptance without weakening promotion installs.
The reusable job name remains `check`, and `upload-artifacts: false` disables
evidence upload without changing the job conclusion used by branch protection.

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

### Publish Stage

`lifecycle.publish` is the project-owned side-effect stage. It may call npm,
PyPI, Conan, CMake packaging scripts, Docker/OCI registries, S3 uploaders, or
any other publisher. Buildchain does not assume the tool; it assumes the
evidence contract.

```toml
[lifecycle.publish]
script = """
set -euo pipefail
python scripts/publish_wheels.py
node scripts/publish-images.mjs
node scripts/write-publish-evidence.mjs
"""
```

When `actions/promote-buildchain-ref` runs with `publish-transaction: "true"`,
the publish stage receives the transaction identity plus the resolved publish
contract:

```text
BUILDCHAIN_VERSION
BUILDCHAIN_CHANNEL
BUILDCHAIN_SOURCE_SHA
BUILDCHAIN_TARGET_REF
BUILDCHAIN_RELEASE_STATE
BUILDCHAIN_EVIDENCE_DIR
BUILDCHAIN_RELEASE_SHA
BUILDCHAIN_RELEASE_MATERIAL_SHA
BUILDCHAIN_PUBLISH_TOOLING_SHA
BUILDCHAIN_PUBLISH_EVIDENCE
BUILDCHAIN_PUBLISH_MODE
BUILDCHAIN_PUBLISH_AUTH
BUILDCHAIN_NPM_DIST_TAG
BUILDCHAIN_PACKAGE_SET_ORDER
BUILDCHAIN_PACKAGE_SET_MAIN_PACKAGE
```

The stage must write publish evidence JSON. Buildchain validates that evidence
before exact tags and floating refs move. In GitHub Actions, the promotion
action also persists `state.json` and `evidence.json` to
`refs/heads/buildchain/release-state/<version>` so fresh runners can recover
without local workspace residue. See
[`docs/publish-transaction.md`](publish-transaction.md) for the state machine,
evidence schema, and recovery commands.

For npm packages, prefer:

```toml
[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "latest"
```

Use `mode = "promote-existing-version"` only for explicit same-version
dist-tag recovery, and pair it with `auth = "npm-token"`. Trusted Publishing
does not authorize `npm dist-tag add`; Buildchain fails that combination before
any publish transaction side effect.

## Promotion Semantics

`actions/promote-buildchain-ref` consumes `version.files`, `lifecycle.verify`,
and optionally `lifecycle.publish`.

The verify stage runs after Buildchain has applied the generated version-state
changes to the local checkout, and before it creates release commits or moves
refs. After the command finishes, Buildchain checks that only declared
version-state files changed. This prevents verification from quietly adding
extra source changes to the release commit.

Buildchain-owned untracked runtime evidence is excluded only through an exact
internal allowlist. This includes contract-drift issue material under
`.buildchain/contract-drift/` and the paper workflow's
`.buildchain/publication-result.json`, alongside release-candidate, passport,
release-state, KFD, and runtime evidence directories. Tracked changes, ordinary
source files, and undeclared `.buildchain/*` paths still fail version
verification.

On protected alpha and release branches, the generated version-state commit is
applied by the promotion automation after the reviewed channel PR has merged.
Buildchain keeps review requirements, conversation resolution, strict status
checks, and admin enforcement for human channel changes, but adds the
authenticated promotion token user or app to the managed bypass allowlist for
generated release bookkeeping. Buildchain also creates the configured required
check on the exact generated version-state commit before patching the protected
ref, then applies the protected ref update with the declared generated ref
update token. The reusable wrapper uses
`secrets.BUILDCHAIN_PROMOTION_TOKEN || github.token` for that protected
bookkeeping update. If release finalization bookkeeping is still rejected,
Buildchain creates or reuses a same-repository `buildchain/version-state/*` PR
from the current target channel head and reports `finalization-needed=true` so
a later idempotent promotion run can resume. Strict alpha bookkeeping remains
fail-fast with a token/protection diagnostic instead of asking humans to review
a post-publish version-state PR.

For `version.strategy = "anchored"` with `version.next = "manual"`, release
promotion does not generate a Buildchain-owned version-state commit. In that
mode, a protected `alpha -> release` PR may carry the declared `version.files`
from the tested alpha package version to the final package version, and may
carry the configured `version.manifest` with it. Buildchain only accepts that
release tree difference when the PR is the valid channel-promotion PR, the
changed paths are limited to those declared version files plus the anchor
manifest, and `lifecycle.verify` or `verification-command` has validated the
checked-out release material. Any code or undeclared file change still fails the
release tree gate.

The action input `verification-command` remains supported. When it is provided,
it overrides `lifecycle.verify` for that invocation. The override inherits
`[lifecycle.env]` and `lifecycle.verify.env`; when the configured stage declares
`shell`, it also inherits that shell. If the stage has no explicit shell,
Buildchain preserves the platform-default shell for compatibility.

## Migration Preflight

Heavy repositories can validate their Buildchain declaration before they are
ready to run the real build. `actions/validate-config` checks that
`.buildchain/buildchain.toml` parses, configured version-state files exist, configured
version keys are strings, and required lifecycle stage names are declared.
For web-surface repositories it also validates `project`, `channels`, `deploy`,
`retention`, and `security` declarations.

It does not run lifecycle commands. This is useful for repositories such as
`libnode`, where `lifecycle.build` represents an expensive multi-platform native
build and the first migration milestone is to prove the release metadata and
lifecycle protocol without consuming build runners.

```yaml
- uses: kungfu-systems/buildchain/actions/validate-config@v2
  with:
    require-version-state: "true"
    require-lifecycle-stages: "install,build,verify"
```

Web-surface repositories can use the same action without requiring version
state:

```yaml
- uses: kungfu-systems/buildchain/actions/validate-config@v2
  with:
    require-lifecycle-stages: "build,verify"
```

The action exposes project and deploy metadata through outputs such as
`project-type`, `project-site`, `channels`, and `deploy-adapters-json`.

## Web-Surface Projects

`project.type = "web-surface"` is for sites, docs, browser apps, and operator
consoles whose release object is a deployed surface, not a package version.

```toml
schema = 1

[project]
type = "web-surface"
name = "site-libkungfu-dev"
site = "libkungfu-dev"

[channels.preview]
url_pattern = "https://{alias}.preview.libkungfu.dev"
visibility = "ephemeral"
noindex = true

[channels.staging]
url = "https://staging.libkungfu.dev"
visibility = "protected"
access_control = "managed-network"
edge_auth = "none"
noindex = true
promotable = true

[channels.production]
url = "https://libkungfu.dev"
visibility = "public"
canonical = true
noindex = false

[surfaces.hub]
path = "/"
production_url = "https://libkungfu.dev"
staging_url = "https://staging.libkungfu.dev"
preview_url_pattern = "https://{alias}.preview.libkungfu.dev"

[surfaces.core]
path = "/core/"
production_url = "https://core.libkungfu.dev"
staging_url = "https://core.staging.libkungfu.dev"
preview_url_pattern = "https://core-{alias}.preview.libkungfu.dev"

[deploy.production]
adapter = "aws-s3-cloudfront"
bucket = "libkungfu-dev-production"
artifact_path = "dist"
secret_refs = ["AWS_ROLE_ARN"]
```

See [Web-surface deployments](web-surface-deployments.md) for named surface host
mappings, the manifest, preview alias, retention, cleanup, and dry-run deploy
contract.

## Infra-Contract Projects

`project.type = "infra-contract"` is for infrastructure contract repositories
that need provider-neutral desired, plan, approval, apply, observe, contract,
and propagation evidence. `buildchain init --type infra-contract` wires
`lifecycle.verify` to `buildchain infra-contract --mode ci`, which writes
mutation-free plan, contract, propagation dry-run, evidence bundle, and
verification artifacts under `.buildchain/`. The surface supports
manual-observed, observe-only, and mocked adapter fixtures without reading
cloud state files or executing live infrastructure mutation. See
[Infra Contract](infra-contract.md).

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
