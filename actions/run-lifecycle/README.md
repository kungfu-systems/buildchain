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
