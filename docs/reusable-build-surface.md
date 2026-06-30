# Reusable Build Surface

Buildchain v2 provides a reusable build workflow for repositories that need
Buildchain's release semantics but cannot be described as a simple Node package.
The first target shape is `libnode`: expensive native builds, multiple operating
systems, self-hosted runner labels, and release artifacts that must be auditable.

## Workflow

Stable consumers call:

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
    with:
      working-directory: .
      artifact-name: libnode
      runner-preset: kungfu-v4-self-hosted
      artifact-name-template: "{artifact}-{platform}-{sha}"
      artifact-paths: |
        dist
        build/stage
      expected-artifacts-json: >-
        {"minFiles":2,"requiredPaths":["dist/libnode.tar.gz","dist/checksums.txt"]}
```

`runner-preset` is the stable first-class surface for known runner fleets:

| Preset | Platforms |
| --- | --- |
| `github-hosted` | `ubuntu-24.04`, `macos-latest`, `windows-2022` |
| `kungfu-v4-self-hosted` | Kungfu Linux x64, macOS ARM64, and Windows x64 self-hosted runner labels |
| `custom` | Requires `platforms-json` |

Callers can still provide a custom matrix with `platforms-json`. Each platform
object has:

| Field | Meaning |
| --- | --- |
| `id` | Stable artifact/platform key, such as `linux-x64` |
| `name` | Human-readable job name |
| `runner` | JSON string passed to `runs-on` after `fromJSON` |

The runner field is intentionally a JSON string so callers can pass either
GitHub-hosted runners or multi-label self-hosted runners without Buildchain
guessing the labels.

Only include platforms that should run. GitHub schedules matrix jobs before
steps execute, so a disabled entry with unavailable runner labels can still
block the workflow queue.

## Workflow Outputs

The reusable workflow exposes the resolved contract:

| Output | Meaning |
| --- | --- |
| `runner-preset` | Resolved preset, or `custom` when `platforms-json` was provided |
| `platforms-json` | Exact matrix JSON used by the build job |
| `platform-count` | Number of matrix platforms |
| `build-summary-artifact` | Uploaded aggregate summary artifact name |
| `build-summary-json` | Compact aggregate JSON with platform count, file count, and byte total |

The aggregate summary is intentionally an artifact as well as an output. GitHub
Actions matrix outputs are not a reliable place to carry every platform's full
manifest, so Buildchain uploads each platform manifest and then emits one
aggregate summary artifact after the matrix completes.

## Command Sources

The workflow runs `buildchain.toml` lifecycle stages by default:

```toml
[lifecycle.install]
command = "corepack yarn install --immutable"

[lifecycle.build]
commands = [
  "corepack yarn make",
  "corepack yarn build",
]

[lifecycle.verify]
command = "corepack yarn test"
```

Callers can override any stage for one invocation:

```yaml
with:
  build-command: cmake --build build --config Release
  verify-command: ctest --test-dir build --output-on-failure
```

For custom workflows, use the action directly:

```yaml
- uses: kungfu-systems/buildchain/actions/run-lifecycle@v2
  with:
    stage: build
    required: "true"
    artifact-name: libnode-linux-x64-${{ github.sha }}
    artifact-paths: |
      dist
      build/stage
```

## Artifact Contract

Each platform upload uses `artifact-name-template`. The default is:

```text
{artifact}-{platform}-{sha}
```

Supported placeholders are `{artifact}`, `{artifactName}`, `{platform}`,
`{platformId}`, `{platformName}`, `{sha}`, `{shortSha}`, `{ref}`, `{runId}`,
and `{runAttempt}`. Invalid GitHub artifact name characters are normalized to
`-`, so `{ref}` remains deterministic even for refs such as
`refs/heads/dev/v2/v2.0`.

Each platform also writes and uploads:

```text
.buildchain/artifacts/<platform-id>/manifest.json
.buildchain/artifacts/<platform-id>/summary.json
```

The manifest schema is:

```json
{
  "schemaVersion": 1,
  "contract": "kungfu-buildchain-artifact",
  "artifactName": "libnode-linux-x64-<sha>",
  "platform": {
    "id": "linux-x64",
    "name": "Linux x64",
    "os": "Linux",
    "arch": "X64"
  },
  "git": {
    "repository": "kungfu-systems/libnode",
    "sha": "<sha>",
    "ref": "<ref>",
    "runId": "<run id>",
    "runAttempt": "<attempt>"
  },
  "lifecycle": {
    "stage": "verify",
    "commandSource": "buildchain.toml",
    "executed": true
  },
  "summary": {
    "contract": "kungfu-buildchain-artifact-summary",
    "artifactName": "libnode-linux-x64-<sha>",
    "fileCount": 1,
    "totalBytes": 1234,
    "digest": "<hex>"
  },
  "expectedArtifacts": {
    "ok": true,
    "source": "expected-artifacts-json",
    "checks": []
  },
  "files": [
    {
      "path": "dist/example.zip",
      "size": 1234,
      "sha256": "<hex>"
    }
  ]
}
```

Artifact names do not include actor names, timestamps, or retry counters. Reruns
produce a new GitHub Actions run but keep the same source SHA/platform contract.

`expected-artifacts-json` fails the build before upload when the artifact does
not match the caller's declared contract. Supported checks are:

| Field | Meaning |
| --- | --- |
| `minFiles` | Minimum number of manifest files |
| `maxFiles` | Maximum number of manifest files |
| `minTotalBytes` | Minimum total byte count |
| `requiredPaths` | Exact manifest paths that must exist |

## Trusted Event Gate

The workflow has an explicit `trust-gate` job. By default, pull requests from
forks fail before any build job can reach self-hosted runners, secrets,
publishing credentials, or heavyweight build commands. Same-repository PRs,
workflow dispatches, and protected branch events can proceed.

If a repository wants fork PRs to skip rather than fail, it can set:

```yaml
with:
  untrusted-policy: skip
```

Do not set `require-trusted-event: false` for workflows that use self-hosted
runners or secrets.

## Fixture

`fixtures/libnode-shaped` is the contract fixture. It has:

- `package.json` version state;
- `buildchain.toml` with `install`, `build`, and `verify`;
- cross-platform Node scripts that create small `dist/` outputs;
- `Build Surface Fixture` workflow coverage.

The fixture proves the reusable surface without running the real libnode native
build.
