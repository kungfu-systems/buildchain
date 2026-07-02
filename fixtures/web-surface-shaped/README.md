# Web Surface Shaped Fixture

This fixture models a static site repository that wants Buildchain deployment
semantics without opting into package release lines.

It proves that `project.type = "web-surface"` can declare preview, staging, and
production channels, named surface host mappings, deterministic deployment
manifests, and dry-run deploy and cleanup plans without touching AWS.

The fixture is shaped like a `site-libkungfu-dev` repository with three
first-class surfaces:

```text
hub        https://libkungfu.dev
core       https://core.libkungfu.dev
buildchain https://buildchain.libkungfu.dev
```

For preview and staging, Buildchain resolves the same surface names to the
channel-specific hosts and records them in `surfaceBindings`. Path-only pages
can still be declared with `path_only = true`, but this fixture intentionally
uses first-class hosts for every surface so validation can catch missing
channel mappings.
