# Reusable Build Surface

Buildchain v2 provides a reusable build workflow for repositories that need
Buildchain's release semantics but cannot be described as a simple Node package.
The first target shape is `libnode`: expensive native builds, multiple operating
systems, self-hosted runner labels, and release artifacts that must be auditable.

## Automatic Channel Router

The preferred consumer surface is one reusable workflow call. After v2.12
reaches the stable major ref, consumers keep this configuration for both alpha
development and stable release work:

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/build.yml@v2
    permissions:
      contents: read
      issues: write
      id-token: write
    with:
      working-directory: .
      artifact-name: libnode
      runner-preset: kungfu-v4-self-hosted
      publish-channel: none
    secrets: inherit
```

`buildchain-channel` defaults to `auto`. Selection uses this precedence:

1. an explicit `buildchain-ref` train, SHA, or official channel;
2. an explicit `buildchain-channel: alpha|stable`;
3. `publish-channel: alpha|release|major`;
4. GitHub release prerelease metadata;
5. a canonical semver tag;
6. non-release PR, push, dispatch, schedule, and workflow-run events default to
   alpha.

The resolved runtime is `vN-alpha` for development and prerelease intent and
`vN` for stable release intent. Unknown custom publish channels, malformed
release events, and non-semver release-like tags fail before the build matrix;
they never guess alpha for a stable release.

The router automatically selects `.buildchain/alpha-contract-lock.json` for
alpha and `.buildchain/contract-lock.json` for stable. A repository can override
the common path with `buildchain-contract-lock-path`, or override one channel
with `buildchain-alpha-contract-lock-path` /
`buildchain-stable-contract-lock-path`.

Only repositories changing the default policy need extra routing input:

```yaml
with:
  buildchain-channel: stable
```

During the v2.12 prerelease evaluation window, canaries use
`build.yml@v2-alpha`. The same router then selects `v2-alpha` or stable `v2` as
the runtime. Production consumers should adopt `build.yml@v2` after the router
has reached stable; this keeps the routing shell itself on a stable ref.

The router is generated from `.build.yml`'s input/output surface. Run
`node scripts/generate-channel-build-workflow.mjs` after changing the advanced
build workflow; inventory and unit tests reject a stale generated router.

## Advanced Workflow

Consumers that need direct workflow-shell or runtime control call the advanced
surface:

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
    with:
      working-directory: .
      artifact-name: libnode
      runner-preset: kungfu-v4-self-hosted
      linux-container-preset: kungfu-verify
      artifact-name-template: "{artifact}-{platform}-{sha}"
      artifact-paths: |
        dist
        build/stage
      expected-artifacts-json: >-
        {"minFiles":2,"requiredPaths":["dist/libnode.tar.gz","dist/checksums.txt"]}
      process-summary-path: .buildchain/diagnostics/process-summary.json
      release-candidate: true
      publish-channel: release
      publish-source-ref: publish-gate/release/v22/v22.22/22.22.3-kf.0
```

`runner-preset` is the stable first-class surface for known runner fleets:

| Preset                  | Platforms                                                                |
| ----------------------- | ------------------------------------------------------------------------ |
| `github-hosted`         | `ubuntu-24.04`, `macos-latest`, `windows-2022`                           |
| `kungfu-v4-self-hosted` | Kungfu Linux x64, macOS ARM64, and Windows x64 self-hosted runner labels |
| `custom`                | Requires `platforms-json`                                                |

Callers can still provide a custom matrix with `platforms-json`. Each platform
object has:

| Field    | Meaning                                           |
| -------- | ------------------------------------------------- |
| `id`     | Stable artifact/platform key, such as `linux-x64` |
| `name`   | Human-readable job name                           |
| `runner` | JSON string passed to `runs-on` after `fromJSON`  |

The runner field is intentionally a JSON string so callers can pass either
GitHub-hosted runners or multi-label self-hosted runners without Buildchain
guessing the labels.

Only include platforms that should run. GitHub schedules matrix jobs before
steps execute, so a disabled entry with unavailable runner labels can still
block the workflow queue.

## Linux Job Containers

Linux build platforms can run inside a digest-pinned job container while macOS
and Windows keep using native runners. This is the recommended way to remove
moving Linux runner prerequisites from Buildchain consumers: the Linux host only
needs a GitHub Actions runner, Docker, and network access; common verification
tools come from the image contract.

Use the Kungfu verification image for lifecycle stages that need Git, jq,
Python, uv, and fnm, but do not need native compilation:

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
    with:
      runner-preset: kungfu-v4-self-hosted
      linux-container-preset: kungfu-verify
```

`kungfu-verify` resolves to:

```text
ghcr.io/kungfu-systems/build-images/kungfu-verify@sha256:11f0ba64267ce88174a4f73a9bf833ff4e9c59cd16ec3d08a6432a06c2be6fb1
```

Callers that own a different Linux image can pass it explicitly:

```yaml
with:
  linux-container-preset: custom
  linux-container-image: ghcr.io/example/project-build@sha256:<digest>
```

`linux-container-image` should be pinned by digest. A floating tag makes the
runner surface mutable and weakens Buildchain's release evidence.

The workflow splits the matrix into two build jobs:

- Linux platforms go to `build-linux-container` when a Linux container is
  configured.
- All other platforms go to `build-native`.

Artifact names, manifest paths, expected artifact checks, publish-source locks,
and aggregate summaries are the same in both jobs. The split is an execution
detail, not a different artifact contract.

## Native Rust Toolchains

Native lifecycle jobs can request an isolated Rust installation instead of
depending on a self-hosted runner user's PATH:

```yaml
with:
  setup-rust: true
  rust-toolchain: "1.96.0"
  rustup-dist-server: "https://rsproxy.cn"
  rustup-update-root: "https://rsproxy.cn/rustup"
```

`setup-rust` defaults to `false`, so existing consumers are unchanged. When it
is enabled, Buildchain installs `rust-toolchain` before the install, build, and
verify lifecycle stages on every native matrix platform. Windows uses the
official rustup bootstrap through `cmd.exe` and `curl.exe` into runner-temporary
Cargo and rustup homes, so it works under a restrictive PowerShell execution
policy and the service account does not depend on another user's PATH or mutate
host toolchain state. Pin an exact toolchain for release builds. Linux container jobs continue
to obtain Rust from their digest-pinned image contract; Buildchain does not
mutate that container surface.

The rustup server inputs are optional and default to Rust's official servers.
Consumers behind a slow cross-border link may select a trusted transport mirror;
rustup still verifies the selected toolchain's distribution metadata and
component checksums.

The container image provides `fnm` but does not preinstall Node. Buildchain uses
`fnm` inside the container to install the requested `node-version` before it
runs Buildchain runtime scripts or lifecycle actions.

Do not use `kungfu-verify` for stages that need CMake, Ninja, ccache, Conan, or
Docker image publishing. Those should use a heavier native-build image or remain
on a host runner until their image contract is explicit.

## Buildchain Runtime Override

Stable consumers should keep the reusable workflow pinned to stable refs such as
`@v2`. The optional `buildchain-ref` input is empty by default; empty means
Buildchain resolves and executes the stable runtime selected by the workflow
shell. The full train validation protocol is documented in
[`runtime-train-validation.md`](runtime-train-validation.md).

For one-off manual validation, a trusted maintainer can run the caller workflow
with a temporary runtime override:

```yaml
on:
  workflow_dispatch:
    inputs:
      buildchain-ref:
        description: "Temporary Buildchain runtime ref for trusted manual validation"
        required: false
        default: ""

jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
    with:
      buildchain-ref: ${{ inputs.buildchain-ref || '' }}
```

Allowed override refs are deliberately narrow:

| Ref form | Meaning |
| --- | --- |
| `train/v2/v2.3/<capability>` | Temporary capability train under the active minor line |
| `refs/heads/train/v2/v2.3/<capability>` | Explicit branch ref for the same train |
| `<40-character SHA>` | Exact immutable Buildchain runtime commit |

Override requests fail closed unless the event is `workflow_dispatch` and the
actor has write, maintain, or admin permission on the caller repository.
Pull requests, including same-repository pull requests and fork-originated pull
requests, cannot use `buildchain-ref` override. This keeps automated PR builds on
the stable runtime surface.

Every run resolves the runtime ref to an immutable SHA before checkout. The job
summary and aggregate build summary record the workflow shell ref, requested
runtime ref, resolved runtime ref, runtime SHA, stability class, trust decision,
and rollback ref. Train refs are development validation refs: they do not move
`v2`, `vX.Y`, `vX.Y-alpha`, npm dist-tags, or production release refs, and they
must not be pinned as long-term production dependencies.

Runtime override validates Buildchain runtime scripts, CLI code, local actions,
config parsing, and lifecycle behavior. It cannot validate changes that require
the outer reusable workflow YAML itself to change, such as new jobs,
permissions, workflow outputs, or matrix topology. Those changes need a canary
workflow path or a temporary explicit workflow ref.

## Floating Ref Contract Lock

Stable consumers should use floating major refs such as `@v2`, but a floating
ref is not blind trust. Each released Buildchain ref carries a package-owned
runtime contract world in `dist/site/buildchain-contract.json`. Consumers may
keep a small lock file, `.buildchain/contract-lock.json`, recording the
Buildchain ref, resolved SHA, contract digest, compatibility digest, accepted
major line, and compatibility policy they reviewed.

The reusable build trust gate checks this lock before any heavy matrix job:

1. resolve the Buildchain runtime ref, for example `v2`, to an immutable SHA;
2. read `dist/site/buildchain-contract.json` from that checked-out Buildchain
   ref;
3. read the consumer's `.buildchain/contract-lock.json`;
4. compare the accepted contract with the current contract.

SHA drift alone is not a failure. `v2` is expected to advance. Buildchain only
fails fast when the accepted contract is no longer compatible, for example a
required input is removed, a required output disappears, a protected behavior
promise changes, or the major line changes. Additive changes such as optional
inputs, optional outputs, diagnostics, or documentation updates continue under
the default `major-compatible` policy.

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
    permissions:
      contents: read
      issues: write
      id-token: write
    with:
      buildchain-contract-lock-path: .buildchain/contract-lock.json
      buildchain-contract-compatibility-policy: major-compatible
      buildchain-contract-drift-issue-mode: compatible-and-breaking
```

When compatible drift is detected, the build continues and Buildchain opens or
updates a low-priority issue in the consumer repository. The issue records the
old SHA/digest, new SHA/digest, compatibility result, workflow run, and the next
action: review the Buildchain release notes and update the lock. When breaking
drift is detected, the same issue path is used, but the trust gate fails before
matrix build or publish work starts. If the workflow token cannot write issues,
Buildchain writes a copyable issue body into the job summary.

The lock is intentionally small. It does not copy the full contract. The full
contract remains in the Buildchain ref and package; the consumer records only
what it accepted and the policy used to compare future floating-ref movement.

Advanced alpha-channel consumers select the matching workflow shell:

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2-alpha
    with:
      buildchain-contract-lock-path: .buildchain/contract-lock.json
```

The runtime follows the called workflow through `job.workflow_ref`. Callers may
also pass `buildchain-ref: v2-alpha` explicitly; official floating refs are
ordinary channel selections and are allowed on pull requests and pushes. Train
refs and exact SHAs remain trusted manual overrides.

## Locked Source Checkout Cache

Self-hosted runners that build large repositories can opt into a locked checkout
cache for both the consumer source and the Buildchain runtime. This changes only
the Git object transport. Buildchain still resolves `publish-source-sha` and the
runtime SHA before any build runner starts, checks out those exact commits, and
verifies each final `HEAD` plus the resolved consumer source tree SHA before
lifecycle commands run.

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
    with:
      runner-preset: kungfu-v4-self-hosted
      checkout-cache-mode: auto
      checkout-cache-mirror-url-template: ${{ vars.BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE }}
      checkout-cache-reference-repository-template: ${{ vars.BUILDCHAIN_CHECKOUT_CACHE_REFERENCE_REPOSITORY_TEMPLATE }}
      checkout-cache-fallback: github
      checkout-cache-timeout-seconds: 60
      checkout-cache-github-timeout-seconds: 600
      checkout-cache-fetch-attempts: 3
```

`checkout-cache-mode` accepts:

| Mode | Behavior |
| --- | --- |
| `off` | Default. Buildchain fetches the locked commit from GitHub. |
| `auto` | Try the trusted cache first; on miss, record the miss and fall back according to `checkout-cache-fallback`. |
| `require` | Require the cache to provide the locked commit and fail before lifecycle work if unavailable. |

The cache can be a local/LAN mirror URL template or a runner-local bare
reference repository template. Templates support `{owner}`, `{repo}`,
`{repository}`, `{repositorySlug}`, and `{sha}`. The workflow also reads
repository or organization variables named
`BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE` and
`BUILDCHAIN_CHECKOUT_CACHE_REFERENCE_REPOSITORY_TEMPLATE`, so consumers can keep
private LAN topology out of repository YAML.

The GitHub-hosted trust gate resolves the reusable workflow shell to an exact
commit and uploads that shell's small checkout bootstrap script. Native and
Linux-container build jobs download the bootstrap, then use the same cache
policy to obtain both the selected Buildchain runtime and consumer source at
their already resolved immutable SHAs. Keeping the bootstrap owned by the
workflow shell is important when `@vN-alpha` routes a stable release to an older
`vN` runtime: the stable runtime does not need to already contain the newest
checkout transport implementation. This also prevents a large direct
`actions/checkout` runtime clone from becoming a separate timeout path on
constrained self-hosted uplinks. The bootstrap artifact does not contain the
runtime repository and cannot move either selected ref.

Do not read cache URLs or reference paths from PR-controlled files such as
`.buildchain/buildchain.toml`. These values are trusted workflow inputs or repo/org
variables. Buildchain does not pass GitHub credentials to cache mirrors or
reference repositories. If it must fall back to GitHub, the workflow token is
used only for the GitHub fetch path. Cache attempts use
`checkout-cache-timeout-seconds`; the potentially larger GitHub fallback uses
the independent `checkout-cache-github-timeout-seconds` budget (600 seconds by
default). Buildchain fetches the advertised source ref before trying an exact
SHA, so a cache hit or stale-cache seed can contribute objects and the fallback
does not first waste a full timeout on an unadvertised SHA. Retryable timeout
and transient network failures use the bounded `checkout-cache-fetch-attempts`
budget; permanent failures stop immediately. Diagnostics record both timeout
budgets and the actual GitHub fetch attempts before exact HEAD/tree
verification.

Each platform diagnostics artifact includes `source-checkout.json` and embeds a
compact `sourceCheckout` summary in `diagnostics.json`: mode, transport,
hit/miss, fallback reason, duration, final HEAD verification, and tree
verification. Remote URLs are sanitized and local reference paths are represented
by a short display name plus fingerprint, not by secret-bearing credentials.
Runtime checkout evidence is uploaded separately as `runtime-checkout.json`,
including cache transport, fallback attempts, and exact runtime `HEAD`
verification, even when a later lifecycle step fails.

When a Buildchain maintainer asks for downstream validation, the expected
request is:

```text
Buildchain train ready: buildchain-ref=train/v2/v2.3/<capability>.
Keep uses: ...@v2; run workflow_dispatch with that buildchain-ref and report the runtime evidence summary.
```

After validation succeeds, the Buildchain change should continue through the
normal mainline and release path. Do not treat the train as a pending merge
item; it is only a temporary fast-use, diagnostic, and rollback channel. It may
remain for a retention window after release, with old trains handled by a
separate periodic cleanup task.

## Workflow Outputs

The reusable workflow exposes the resolved contract:

| Output                            | Meaning                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `runner-preset`                   | Resolved preset, or `custom` when `platforms-json` was provided                 |
| `platforms-json`                  | Exact matrix JSON used by the build job                                         |
| `platform-count`                  | Number of matrix platforms                                                      |
| `linux-container-enabled`         | `true` when Linux platforms are routed through a job container                  |
| `linux-container-image`           | Resolved digest-pinned Linux job container image                                |
| `build-summary-artifact`          | Uploaded aggregate summary artifact name                                        |
| `build-diagnostics-summary-artifact` | Uploaded aggregate diagnostics summary artifact name                         |
| `release-candidate-passport-artifact` | Uploaded PR-stage release-candidate passport artifact name when `release-candidate` is enabled |
| `release-candidate-passport-json` | Compact release-candidate passport JSON when `release-candidate` is enabled     |
| `build-summary-json`              | Compact aggregate JSON with platform count, file count, and byte total          |
| `build-diagnostics-summary-json`  | Compact aggregate diagnostics JSON with platform, lifecycle warning/error, diagnostics contract warning, and sidecar manifest warning totals |
| `trusted-event`                   | `true` when the event is trusted enough to reach build runners                  |
| `buildchain-runtime-ref`          | Runtime ref selected after applying the empty-default or override policy        |
| `buildchain-runtime-sha`          | Immutable Buildchain runtime commit used by all runtime checkouts               |
| `buildchain-runtime-class`        | `stable`, `alpha`, `train`, `exact-sha`, or `development`                       |
| `buildchain-runtime-override`     | `true` when a train or exact-SHA `buildchain-ref` override was accepted          |
| `buildchain-runtime-trust-decision` | Runtime override trust decision                                               |
| `buildchain-contract-lock-status` | `unchanged`, `compatible-drift`, `breaking-drift`, `missing-lock`, `non-floating-runtime`, or first-release `runtime-contract-unavailable` |
| `buildchain-contract-lock-drift`  | `true` when the floating runtime SHA or contract digest changed                 |
| `buildchain-contract-digest`      | Current Buildchain runtime contract digest                                      |
| `publish-channel`                 | Resolved publish channel requested by the caller                                |
| `publish-allowed`                 | `true` only when this event/ref may publish after verification                  |
| `publish-reason`                  | Human-readable reason for the publish gate decision                             |
| `publish-source-ref`              | Gate source ref that was resolved before checkout                               |
| `publish-source-sha`              | Exact source commit used by checkout, build, verify, and artifacts              |
| `publish-source-locked`           | `true` when a `publish-gate/*` source ref was explicitly locked                 |
| `publish-source-channel`          | `alpha`, `release`, `anchor`, or `major` parsed from the source ref             |
| `publish-source-line`             | Product line parsed from source refs such as `v22/v22.22`                       |
| `publish-source-consumer-version` | Consumer package version parsed from source refs                                |
| `release-manifest-json`           | Resolved release manifest including source lock, version state, and anchor data |

The aggregate summaries are intentionally artifacts as well as outputs. GitHub
Actions matrix outputs are not a reliable place to carry every platform's full
manifest, so Buildchain uploads each platform manifest and then emits one
aggregate build summary artifact after the matrix completes. Buildchain uploads
`diagnostics-summary.json` as a separate aggregate diagnostics summary artifact,
a compact rollup of each platform's small diagnostics upload. The rollup keeps
per-platform runner facts, checked tool versions/missing tools, package
manager/cache directory details, compiler-cache availability, lifecycle timing,
process sampler context, and links back to the exact platform artifacts. Each
platform diagnostics upload includes `diagnostics.json`,
`diagnostics-manifest.json`, the lifecycle `events.jsonl`, and process sampler
sidecars when enabled, so slow-build diagnosis does not require downloading the
binary platform artifact or the aggregate build summary. The sidecar manifest
records the uploaded diagnostics files with bytes and sha256 hashes. Each
`diagnostics.json` also records the related binary artifact name, manifest
artifact name, diagnostics artifact name, diagnostics sidecar manifest path, and
platform id in `links`, so a reviewer can navigate from the small diagnostics
artifact back to the exact platform outputs when deeper inspection is needed.
The workflow output `build-diagnostics-summary-json` includes
`diagnosticsContractWarningCount` and `diagnosticsManifestWarningCount` so
release jobs can detect drifting diagnostics JSON contracts and missing or
drifting diagnostics sidecar manifests without downloading the per-platform
diagnostics artifacts first.

## Artifact Transfer Relay

By default, platform jobs upload payloads, manifests, and diagnostics directly
to GitHub artifacts:

```yaml
with:
  artifact-transfer-mode: github-artifacts
```

Large self-hosted native builds can opt into the first-class S3 relay path:

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
    with:
      runner-preset: kungfu-v4-self-hosted
      artifact-transfer-mode: s3-to-github-artifacts
      artifact-relay-s3-bucket: ${{ vars.BUILDCHAIN_ARTIFACT_RELAY_S3_BUCKET }}
      artifact-relay-s3-region: ${{ vars.BUILDCHAIN_ARTIFACT_RELAY_S3_REGION }}
      artifact-relay-s3-prefix: ${{ vars.BUILDCHAIN_ARTIFACT_RELAY_S3_PREFIX }}
```

In relay mode, each self-hosted platform job uploads the heavy payload files to
S3 and uploads only a small `relay-manifest.json` to GitHub. A GitHub-hosted
`relay-artifacts` job then assumes the configured download role, downloads the
payloads from S3, verifies every file by SHA256, and re-uploads the normal
GitHub artifacts under the same artifact names that direct mode uses. Downstream
summary, release-candidate, and promote-only workflows therefore continue to
consume GitHub artifacts and do not need custom S3 logic.
The relay implementation uses Node.js plus the standard AWS environment
credentials from GitHub OIDC; runner images and build containers do not need the
AWS CLI installed.

After the GitHub artifact uploads succeed, Buildchain deletes the S3 objects
listed in the relay manifest for that platform. If any download, verification,
or GitHub artifact upload fails, cleanup is skipped so maintainers can inspect
the retained S3 payload. Configure a short bucket lifecycle expiration as a
cost and cleanup backstop.

The relay configuration is intentionally generic. Buildchain does not hard-code
organization buckets, regions, or role ARNs. Callers may pass explicit inputs,
or set repository/organization variables and secrets using these names:

| Variable or secret | Meaning |
| --- | --- |
| `BUILDCHAIN_ARTIFACT_RELAY_S3_BUCKET` | Relay bucket name |
| `BUILDCHAIN_ARTIFACT_RELAY_S3_REGION` | Relay bucket region |
| `BUILDCHAIN_ARTIFACT_RELAY_S3_PREFIX` | Relay object prefix; defaults to `buildchain-artifacts` |
| `BUILDCHAIN_ARTIFACT_RELAY_S3_ROLE_ARN` | Shared OIDC role ARN for upload and download |
| `BUILDCHAIN_ARTIFACT_RELAY_S3_UPLOAD_ROLE_ARN` | Upload OIDC role ARN for self-hosted build jobs |
| `BUILDCHAIN_ARTIFACT_RELAY_S3_DOWNLOAD_ROLE_ARN` | Download OIDC role ARN for the GitHub-hosted relay job |
| `BUILDCHAIN_ARTIFACT_RELAY_S3_OIDC_AUDIENCE` | Optional OIDC audience override |

For AWS China regions, Buildchain defaults the OIDC audience to
`sts.amazonaws.com.cn`; other regions default to `sts.amazonaws.com`. The caller
workflow must allow `id-token: write`, and the target role trust policy should
restrict GitHub OIDC claims to the expected organization, repository, workflow,
and branch/ref. The S3 permissions should be scoped to the relay bucket/prefix
used by the repository.
Upload roles need write/delete access under the relay prefix; download roles
need read access plus delete access for successful cleanup.

Relay mode is opt-in and does not affect forks or open-source users that do not
configure S3. Missing bucket, region, upload role, or download role values fail
before the heavy build matrix is scheduled. Buildchain treats S3 as a transport
cache, not as the final release evidence store; the final audit entry remains
the GitHub artifact set plus the Buildchain build summary and release-candidate
passport.

Set `release-candidate: true` when the successful reusable build is meant to be
the artifact source promoted later. Buildchain then uploads
`release-candidate-passport.json` under the
`<artifact-name>-release-candidate-<publish-source-sha>` artifact name. Promotion
jobs can pass that passport to `promote-buildchain-ref` with
`promote-only-release-candidate: "true"` so source, channel, platforms, and the
aggregate build-summary hash are checked before publish-gate side effects. The
passport records the locked commit's Git tree SHA, so a post-merge channel HEAD
can be accepted only when it is tree-equivalent to the PR-stage build evidence.

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

| Channel   | Allowed refs                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `none`    | Never publishes; this is the default                                                                 |
| `alpha`   | `alpha/vN/vN.M` branches or exact `vN.M.P-alpha.K` tags                                              |
| `release` | `release/vN/vN.M` branches or release tags such as `vN.M.P`, `vN.M`, `vN`                            |
| `major`   | `publish-gate/major`, legacy `major-gate`, or next-major release tags such as `vN.0.0`, `vN.0`, `vN` |

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

| Ref                                              | Meaning                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `publish-gate/alpha/<line>/<consumer-version>`   | Build and publish an alpha candidate for a consumer line                    |
| `publish-gate/release/<line>/<consumer-version>` | Build and publish a production candidate for a consumer line                |
| `publish-gate/anchor`                            | Resolve an explicit anchor request; it does not publish artifacts by itself |
| `publish-gate/major`                             | Gate the next major source state                                            |
| `major-gate`                                     | Legacy compatibility alias for the major gate                               |

For alpha and release refs, `<line>` is intentionally allowed to contain `/`, so
Kungfu-style lines such as `v22/v22.22` stay readable. The final path segment is
the consumer-visible version, for example `22.22.3-kf.0`.

The reusable workflow resolves the branch tip to `publish-source-sha`, checks out
that SHA in every build job, and uses the same SHA in artifact names, manifests,
and aggregate summaries. Reruns therefore rebuild the same source tree even if a
gate branch moves later.

Before any heavy build matrix is scheduled, the workflow also verifies that the
target channel ref implied by the source lock already points at
`publish-source-sha` and that the target channel HEAD came from the required
merged same-repository channel PR. `publish-gate/alpha/<line>/<version>` must
match `alpha/<line>` and have PR lineage `dev/<line> -> alpha/<line>`;
`publish-gate/release/<line>/<version>` must match `release/<line>` and have PR
lineage `alpha/<line> -> release/<line>`. If either check fails, the run fails
fast with a diagnostic telling maintainers to merge the source commit through
the channel PR first. This keeps verify from spending runner time on a source
tree that cannot legally enter the requested publish channel.

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

## Release Candidate Promote-Only

For native package sets, the PR build is the only heavy build. When a PR targets
`alpha/<line>` or `release/<line>`, `.build.yml` uploads a release-candidate
bundle next to the platform artifacts. The bundle contains:

- `release-candidate.passport.json`;
- the aggregate `build-summary.json`;
- copied platform manifest evidence for the built platforms.

The passport records two separate source identities:

- `builtSourceSha` / `builtSourceTreeSha`: the PR-stage source that produced the
  artifacts, usually the PR merge ref;
- `promotionChannelSha` / `promotionChannelTreeSha`: the post-merge channel
  commit used for publish authority.

The reusable promote wrapper resolves the merged PR, finds exactly one matching
PR-stage release-candidate artifact, downloads it with the build summary and
payload artifacts from the same PR-stage run, validates the payload count,
compares the built tree with the promotion channel tree, locks
`publish-gate/{alpha,release,major}` to the promotion channel commit, and then
calls `actions/promote-buildchain-ref` with
`promote-only-release-candidate: "true"` and
`require-publish-source-lock: "true"`. The wrapper passes the created
`publish-gate/*` ref, target SHA, and `locked=true` into the promote action, so
floating `@v2` consumers receive publish-side source-lock drift protection by
default. It also defaults `branch-protection-bypass-apps` to `github-actions`
so the workflow automation can apply generated version-state and channel
bookkeeping on protected `dev`/`alpha`/`release` branches after the reviewed
channel PR has merged; consumers using a different promotion identity can pass
`branch-protection-bypass-users`, `branch-protection-bypass-teams`, or a
different app slug declaratively. The wrapper uses
`secrets.BUILDCHAIN_PROMOTION_TOKEN || github.token` as the generated ref update
token for protected bookkeeping PATCH calls, so a bypass-capable promotion token
can sync dev immediately after alpha/release publish without a post-publish PR.
It does not call `.build.yml`, does not create a matrix, and must fail before
publish if the RC evidence, payload set, or source-lock ref is missing or
ambiguous.

```yaml
jobs:
  promote:
    uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v2
    secrets:
      buildchain-issue-app-id: ${{ secrets.BUILDCHAIN_ISSUE_APP_ID }}
      buildchain-issue-app-private-key: ${{ secrets.BUILDCHAIN_ISSUE_APP_PRIVATE_KEY }}
    with:
      channel: alpha
      target-ref: alpha/v22/v22.22
      artifact-name: libnode
      # Defaults to build.yml / Build. Override only when the PR-stage build
      # workflow uses a different file or display name.
      release-candidate-workflow-file: build.yml
      release-candidate-workflow-name: Build
      package-manager: npm
      publish-target: npm
      runner-preset: github-hosted
      trusted-publishing: true
      github-release: true
      required-status-check: check / check
      required-artifact-count: 3
      publish-dist-tag: alpha
      publish-package-set-order: platforms-first-main-last
      publish-package-main: "@kungfu-tech/libnode"
      release-passport-product-name: Libnode
      buildchain-contract-lock-path: .buildchain/contract-lock.json
      buildchain-contract-drift-issue-mode: compatible-and-breaking
```

`buildchain-issue-app-id` and `buildchain-issue-app-private-key` are optional
but recommended for cross-repository consumers. They should identify a GitHub
App installation with `issues: write` on `kungfu-systems/buildchain`; the
wrapper mints the installation token before calling
`actions/report-buildchain-issue`. Consumers can also pass a pre-minted
`buildchain-issue-token`. If both are omitted, the wrapper falls back to
`BUILDCHAIN_ISSUE_TOKEN`, `BUILDCHAIN_PROMOTION_TOKEN`, and then the consumer
workflow's `github.token`; the last fallback can only report issues when it has
write access to the target Buildchain repository.

`publish-required-artifacts-json` can still be passed explicitly for custom
publish targets. For the default `publish-artifact-kind: npm` path, consumers do
not download artifacts or run repository scripts to build publish evidence. The
wrapper downloads the PR-stage payload artifacts, finds the downloaded `.tgz`
packages, reads each tarball's `package/package.json` for the real scoped
package name and version, computes the npm `sha512-...` integrity from the
tarball bytes, marks the package matching `publish-package-main` as `role:
main`, marks the rest as `role: platform`, and passes the generated
`publish-required-artifacts-json` to `promote-buildchain-ref` before any publish
side effect. Downloaded platform manifests are still passed into the release
passport unless `release-passport-platform-manifest-paths` is set explicitly.
The same Buildchain contract lock check runs before release-candidate
resolution and before publish. A compatible `v2` drift leaves an issue in the
consumer repository but does not trigger a second heavy build; an incompatible
drift fails before publish side effects.

The wrapper publishes the public release tag as a GitHub Release by default.
After `promote-buildchain-ref` reports a complete release transaction, the
wrapper creates or updates the public release, marks semver prerelease tags
such as `v1.2.3-alpha.0`, `v1.2.3-rc.1`, or `v22.22.3-kf.3-alpha.7` as
`prerelease=true` and `make_latest=false`, marks stable semver tags as latest,
and uploads the publish evidence file plus every file in the generated release
passport directory, including `buildchain.release.json` and `check-report.json`.
For anchored/manual package releases, the public release tag is derived from the
published package version and the internal exact transaction tag remains
available in the release passport.
Consumers do not need to hand-write `gh release` logic to trigger
`release.published` propagation. Set `github-release: false` only for
repositories that intentionally do not maintain GitHub Releases.
If the transaction still needs protected-ref finalization, the wrapper defers
GitHub Release creation until the later run that reaches `state=complete`.

Custom publish jobs can also repeat the channel-ref preflight:

```yaml
- name: Verify publish channel ref still matches
  run: node .buildchain/runtime/scripts/verify-publish-channel-ref.mjs
  env:
    BUILDCHAIN_PUBLISH_SOURCE_REF: ${{ needs.build.outputs.publish-source-ref }}
    BUILDCHAIN_PUBLISH_SOURCE_SHA: ${{ needs.build.outputs.publish-source-sha }}
    BUILDCHAIN_SOURCE_REPOSITORY: ${{ github.repository }}
    GITHUB_TOKEN: ${{ github.token }}
```

Anchored/manual package release jobs should also make the Buildchain promotion
action validate that publication is entering through the same
`publish-gate/{alpha,release,major}` source-lock contract before any package
publish side effect:

```yaml
- name: Promote release ref and publish npm package set
  uses: kungfu-systems/buildchain/actions/promote-buildchain-ref@v2
  with:
    sha: ${{ needs.build.outputs.publish-source-sha }}
    target-ref: release/v22/v22.22
    require-publish-source-lock: 'true'
    publish-source-ref: ${{ needs.build.outputs.publish-source-ref }}
    publish-source-sha: ${{ needs.build.outputs.publish-source-sha }}
    publish-source-locked: ${{ needs.build.outputs.publish-source-locked }}
```

`target-ref` stays the Buildchain channel promotion target, such as
`alpha/v22/v22.22`, `release/v22/v22.22`, or `publish-gate/major`.
`publish-source-ref` is the reviewed source-lock branch that authorized this
specific package publication. For alpha and release package publications, the
source-lock branch must point at the exact channel-line commit that promotion is
validating; it is not a replacement for `target-ref`.

This keeps the version bump commit, publish authorization, and auditable publish
entrypoint on the Buildchain source-lock protocol. The CLI form
`buildchain publish-source validate-anchored-release --json` is still useful for
custom publish scripts, but the preferred GitHub Actions gate is the promotion
action input above. A publish job that still runs directly from `alpha/*` or
`release/*` channel branches fails this check because those refs are channel
state, not publish-gate decisions.

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

The workflow runs `.buildchain/buildchain.toml` lifecycle stages by default:

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

The reusable build workflow samples the build lifecycle by default and carries
the generated summary into the final verify diagnostics. Callers can override
the sidecar path or disable sampling:

```yaml
with:
  sample-process-tree: true
  process-summary-path: .buildchain/diagnostics/process-summary.json
  process-sample-interval-ms: 15000
  requested-parallelism: 20
```

When `sample-process-tree` is true, Buildchain wraps either `build-command` or
the configured `lifecycle.build` stage with `buildchain sample process-tree`.
The path is relative to the checked-out workspace and is read again during the
final verify lifecycle. Custom workflows can still write their own sampler
summary and pass `process-summary-path`; Buildchain reads the file after the
lifecycle command finishes, so it may be produced during the same invocation.
When the build stage is optional, the reusable workflow treats the default
sampler path as optional during verify; an explicitly supplied
`process-summary-path` remains required.

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

| Field           | Meaning                              |
| --------------- | ------------------------------------ |
| `minFiles`      | Minimum number of manifest files     |
| `maxFiles`      | Maximum number of manifest files     |
| `minTotalBytes` | Minimum total byte count             |
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
- `.buildchain/buildchain.toml` with `install`, `build`, `verify`, and `publish`;
- cross-platform Node scripts that create small `dist/` outputs;
- `Build Surface Fixture` workflow coverage.

The fixture proves the reusable surface without running the real libnode native
build.
