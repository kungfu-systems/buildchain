# run-lifecycle

Run a Buildchain lifecycle stage or an explicit command and write a deterministic
artifact manifest.

```yaml
- uses: kungfu-systems/buildchain/actions/run-lifecycle@v1
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
