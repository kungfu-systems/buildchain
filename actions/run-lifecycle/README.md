# run-lifecycle

Run a Buildchain lifecycle stage or an explicit command and write a deterministic
artifact manifest.

```yaml
- uses: kungfu-systems/buildchain/actions/run-lifecycle@v2
  with:
    stage: build
    required: "true"
    artifact-name: my-product-linux-x64-${{ github.sha }}
    artifact-paths: |
      dist
      build/stage
```

When `command` is provided, it overrides `buildchain.toml` for that invocation.
When `command` is empty, the action loads `buildchain.toml` and runs the named
stage.

`timeout-minutes` defaults to 120 and bounds either command source. A
stage-specific `timeout_minutes` in `buildchain.toml` takes precedence. Timeout
errors identify the lifecycle stage and platform so a hung self-hosted build can
be diagnosed after the runner is released.

The action writes both a full manifest and a compact summary. It also exposes
the summary as outputs for reusable workflow callers:

| Output | Meaning |
| --- | --- |
| `manifest-path` | Full manifest path |
| `summary-path` | Compact summary path |
| `artifact-name` | Resolved artifact name |
| `artifact-file-count` | Number of manifest files |
| `artifact-total-bytes` | Total manifest bytes |
| `artifact-summary-json` | One-line JSON summary |
| `expected-artifacts-ok` | `true` when expectations passed |

`expected-artifacts-json` can require exact paths, file count bounds, and a
minimum byte total:

```yaml
with:
  expected-artifacts-json: >-
    {"minFiles":2,"requiredPaths":["dist/app.tar.gz","dist/checksums.txt"]}
```

For long native builds, set `sample-process-tree: "true"` and pass
`process-summary-path`. The action wraps either the explicit `command` or the
configured lifecycle stage with `buildchain sample process-tree`, then embeds
the produced summary in the lifecycle diagnostics artifact:

```yaml
with:
  stage: build
  sample-process-tree: "true"
  process-summary-path: .buildchain/diagnostics/process-summary.json
```

Custom wrappers can still pass an existing sampler report or summary with
`process-summary-path`; the action reads it after the lifecycle command
finishes, so commands may generate the file during the same invocation.
Set `process-summary-required: "false"` when the summary is an optional sidecar,
for example when a reusable workflow may skip an optional build stage.
The diagnostics directory also includes `diagnostics-manifest.json`, a compact
inventory of the diagnostics sidecars with byte counts and sha256 hashes.
