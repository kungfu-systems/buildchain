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
      publish-channel: release
      publish-source-ref: publish-gate/release/v22/v22.22/22.22.3-kf.0
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
| `trusted-event` | `true` when the event is trusted enough to reach build runners |
| `publish-channel` | Resolved publish channel requested by the caller |
| `publish-allowed` | `true` only when this event/ref may publish after verification |
| `publish-reason` | Human-readable reason for the publish gate decision |
| `publish-source-ref` | Gate source ref that was resolved before checkout |
| `publish-source-sha` | Exact source commit used by checkout, build, verify, and artifacts |
| `publish-source-locked` | `true` when a `publish-gate/*` source ref was explicitly locked |
| `publish-source-channel` | `alpha`, `release`, `anchor`, or `major` parsed from the source ref |
| `publish-source-line` | Product line parsed from source refs such as `v22/v22.22` |
| `publish-source-consumer-version` | Consumer package version parsed from source refs |
| `release-manifest-json` | Resolved release manifest including source lock, version state, and anchor data |

The aggregate summary is intentionally an artifact as well as an output. GitHub
Actions matrix outputs are not a reliable place to carry every platform's full
manifest, so Buildchain uploads each platform manifest and then emits one
aggregate summary artifact after the matrix completes.

## Publish Gate

Buildchain separates "may build/verify" from "may publish." A same-repository
pull request may be trusted enough to run the build matrix, but it still must
not publish packages, S3 objects, release pages, or preview aliases. Publishing
is allowed only when the caller explicitly requests a channel and the current
event/ref matches that channel.

Use `publish-channel` to request a channel:

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
    with:
      publish-channel: release

  publish:
    needs: build
    if: ${{ needs.build.outputs.publish-allowed == 'true' }}
    runs-on: ubuntu-24.04
    steps:
      - run: ./scripts/publish.sh
```

Default channels are:

| Channel | Allowed refs |
| --- | --- |
| `none` | Never publishes; this is the default |
| `alpha` | `alpha/vN/vN.M` branches or exact `vN.M.P-alpha.K` tags |
| `release` | `release/vN/vN.M` branches or release tags such as `vN.M.P`, `vN.M`, `vN` |
| `major` | `publish-gate/major`, legacy `major-gate`, or next-major release tags such as `vN.0.0`, `vN.0`, `vN` |

Pull request events always produce `publish-allowed=false`, even when the PR is
from the same repository. Untrusted fork events also produce
`publish-allowed=false`; with the default `untrusted-policy: fail`, the workflow
then fails before any build runner starts.

Projects with their own channel names can pass `publish-refs-json`:

```yaml
with:
  publish-channel: nightly
  publish-refs-json: >-
    {"nightly":["^refs/heads/nightly/v\\d+$"]}
```

The aggregate build summary includes the same publish gate decision under
`publishGate`, so a downloaded artifact summary explains both what was built and
why it was or was not eligible to publish.

## Publish Source Lock

`publish-channel` answers "may this event publish?" Source lock answers "which
source tree is the publish decision about?" A caller can pass `publish-source-ref`
to bind a publish run to a reviewed gate branch before any checkout happens:

| Ref | Meaning |
| --- | --- |
| `publish-gate/alpha/<line>/<consumer-version>` | Build and publish an alpha candidate for a consumer line |
| `publish-gate/release/<line>/<consumer-version>` | Build and publish a production candidate for a consumer line |
| `publish-gate/anchor` | Resolve an explicit anchor request; it does not publish artifacts by itself |
| `publish-gate/major` | Gate the next major source state |
| `major-gate` | Legacy compatibility alias for the major gate |

For alpha and release refs, `<line>` is intentionally allowed to contain `/`, so
Kungfu-style lines such as `v22/v22.22` stay readable. The final path segment is
the consumer-visible version, for example `22.22.3-kf.0`.

The reusable workflow resolves the branch tip to `publish-source-sha`, checks out
that SHA in every build job, and uses the same SHA in artifact names, manifests,
and aggregate summaries. Reruns therefore rebuild the same source tree even if a
gate branch moves later.

The resolved release manifest is uploaded as an artifact and emitted as
`release-manifest-json`. It records:

- source ref, source SHA, channel, line, and consumer version;
- configured version strategy and configured version-state files;
- each version file's value, with release gates failing closed if the configured
  files do not equal the consumer version;
- anchor manifest summary for anchored/manual projects;
- explicit anchor request JSON for `publish-gate/anchor`;
- publish registry, dist-tag, and gate visibility metadata.

Publish side-effect jobs should verify the lock immediately before publishing:

```yaml
- name: Verify publish gate did not move
  run: node .buildchain/runtime/scripts/verify-publish-source-lock.mjs
  env:
    BUILDCHAIN_PUBLISH_SOURCE_REF: ${{ needs.build.outputs.publish-source-ref }}
    BUILDCHAIN_PUBLISH_SOURCE_SHA: ${{ needs.build.outputs.publish-source-sha }}
    BUILDCHAIN_SOURCE_REPOSITORY: ${{ github.repository }}
    GITHUB_TOKEN: ${{ github.token }}
```

If the branch tip no longer matches the manifest SHA, the publish job must fail
closed. Moving a gate branch creates a new publish decision and should produce a
new build run.

## Package-Set Publish Plan

Projects that publish multiple packages should treat package publication as a
package-set operation. Buildchain's package-set planner uses these rules:

- platform packages publish first;
- the main package publishes last;
- the dist-tag move happens only after the full package set is present;
- reruns accept already-published packages only when package name, version, and
  integrity match;
- an existing package with different integrity is a hard failure.

This keeps a consumer from observing a floating dist-tag that points to a main
package before all platform artifacts for the same source SHA are available.

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

`require-trusted-event` controls access to build runners. It does not override
the publish gate: pull requests remain non-publishing events.

## Fixture

`fixtures/libnode-shaped` is the contract fixture. It has:

- `package.json` version state;
- `buildchain.toml` with `install`, `build`, and `verify`;
- cross-platform Node scripts that create small `dist/` outputs;
- `Build Surface Fixture` workflow coverage.

The fixture proves the reusable surface without running the real libnode native
build.
