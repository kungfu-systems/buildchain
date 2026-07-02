# Buildchain Core Package

Shared code lives here when workflow and action migration shows repeated logic
that is worth centralizing.

Current shared surfaces:

- `buildchain.toml` loading and normalization;
- version-state file discovery and update helpers;
- lifecycle stage normalization and execution;
- config validation for release-package and `web-surface` projects.
- toolkit observability logging through `@kungfu-tech/buildchain/logging`;
- release passport creation and verification through
  `@kungfu-tech/buildchain/release-passport`.

## Toolkit Imports

The npm package exports ESM APIs. JavaScript build scripts should import these
APIs directly instead of spawning the `buildchain` CLI:

```js
import { createBuildchainLogger } from "@kungfu-tech/buildchain/logging";

const logger = createBuildchainLogger({ source: "user", component: "native" });
await logger.span("native.package", { phase: "package" }, packageArtifacts);
```

The CLI remains the right surface for GitHub Actions steps, shell scripts, and
non-JavaScript build tools.

Web-surface validation stays in core because both local scripts and GitHub
Actions need the same fail-closed interpretation of project, channel, deploy,
retention, and staging security declarations.
