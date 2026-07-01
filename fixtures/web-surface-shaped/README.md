# Web Surface Shaped Fixture

This fixture models a static site repository that wants Buildchain deployment
semantics without opting into package release lines.

It proves that `project.type = "web-surface"` can declare preview, staging, and
production channels, generate deterministic deployment manifests, and create
dry-run deploy and cleanup plans without touching AWS.

