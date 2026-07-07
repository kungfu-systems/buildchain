# Buildchain Core Package

Shared code lives here when workflow and action migration shows repeated logic
that is worth centralizing.

Current shared surfaces:

- `buildchain.toml` loading and normalization;
- version-state file discovery and update helpers;
- lifecycle stage normalization and execution;
- config validation for release-package and `web-surface` projects.
- toolkit observability logging through `@kungfu-tech/buildchain/logging`;
- toolkit diagnostics and native profile collection through
  `@kungfu-tech/buildchain/diagnostics`;
- release passport creation and verification through
  `@kungfu-tech/buildchain/release-passport`.
- managed README badge facts and marker blocks through
  `@kungfu-tech/buildchain/readme-badges`.

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

Diagnostics consumers should import the published subpath and compare stable
contracts through the exported constants instead of hardcoding JSON contract
names:

```js
import {
  BUILDCHAIN_DIAGNOSTICS_CONTRACT,
  BUILDCHAIN_DIAGNOSTICS_SUMMARY_CONTRACT,
  collectRunnerDiagnostics,
  summarizeDiagnosticsArtifacts,
} from "@kungfu-tech/buildchain/diagnostics";
```

CommonJS scripts can use dynamic imports for the same package surfaces:

```js
const { createBuildchainLogger } = await import("@kungfu-tech/buildchain/logging");
const { collectRunnerDiagnostics } = await import("@kungfu-tech/buildchain/diagnostics");
```

Web-surface validation stays in core because both local scripts and GitHub
Actions need the same fail-closed interpretation of project, channel, deploy,
retention, and staging security declarations.

README badge consumers should import the public subpath and treat Markdown as a
projection of the returned facts:

```js
import { collectReadmeBadgeFacts, renderReadmeBadgeBlock } from "@kungfu-tech/buildchain/readme-badges";

const facts = await collectReadmeBadgeFacts({ cwd: process.cwd() });
const markdown = renderReadmeBadgeBlock(facts);
```
