# Libnode-shaped Fixture

This fixture models the Buildchain contract needed by `kungfu-systems/libnode`
without running the real native build.

It is intentionally small, but it keeps the important shape:

- `package.json` is the version-state file;
- `buildchain.toml` declares `install`, `build`, and `verify` lifecycle stages;
- lifecycle commands are Node-based and cross-platform;
- build output lands under `dist/`, which the reusable build workflow uploads
  with a deterministic artifact name and manifest.
