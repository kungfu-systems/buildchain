# Libnode-shaped Fixture

This fixture models the Buildchain contract needed by `kungfu-systems/libnode`
without running the real native build.

It is intentionally small, but it keeps the important shape:

- `package.json` is the package version-state file;
- `libnode.release.json` is the explicit upstream anchor manifest;
- `buildchain.toml` declares `install`, `build`, and `verify` lifecycle stages;
- `version.strategy = "anchored"` and `version.next = "manual"` tell
  Buildchain to validate the current anchor instead of deriving the next Node
  anchor automatically;
- lifecycle commands are Node-based and cross-platform;
- build output lands under `dist/`, which the reusable build workflow uploads
  with a deterministic artifact name and manifest.
