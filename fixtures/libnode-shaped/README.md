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
  with a deterministic artifact name and manifest;
- the fixture can be resolved through a publish-gate source lock, which binds
  the requested consumer version to `package.json` and `libnode.release.json`
  before any publish side effect is allowed;
- `[publish]` declares the normal token-free path:
  `mode = "publish-final-version"` with `auth = "trusted-publishing"`, `latest`
  as the release dist-tag, and platform packages published before the main
  package.
