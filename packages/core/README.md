# Buildchain Core Package

Shared code lives here when workflow and action migration shows repeated logic
that is worth centralizing.

Current shared surfaces:

- `buildchain.toml` loading and normalization;
- version-state file discovery and update helpers;
- lifecycle stage normalization and execution;
- config validation for release-package and `web-surface` projects.

Web-surface validation stays in core because both local scripts and GitHub
Actions need the same fail-closed interpretation of project, channel, deploy,
retention, and staging security declarations.
