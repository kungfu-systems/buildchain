# validate-config

Buildchain v1 action for validating `buildchain.toml` without running lifecycle
commands.

Use this action during repository migration when a heavyweight project needs to
prove that its Buildchain version state and lifecycle declaration are ready, but
the actual build should not run yet.

## Usage

```yaml
- uses: kungfu-systems/buildchain/actions/validate-config@v1
  with:
    require-version-state: "true"
    require-lifecycle-stages: "install,build,verify"
```

The action checks:

- `buildchain.toml` exists and uses schema `1`;
- configured version-state files exist and expose a string version;
- required lifecycle stages are declared and structurally valid.

It does not execute `lifecycle.install`, `lifecycle.build`, `lifecycle.verify`,
or any other lifecycle command.

