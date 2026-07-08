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
- source/version/module/product build facts through
  `@kungfu-tech/buildchain/build-facts`;
- release passport creation and verification through
  `@kungfu-tech/buildchain/release-passport`.
- managed KFD / Release Passport badge bundle facts and README marker blocks
  through `@kungfu-tech/buildchain/badges`.

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

Build facts consumers can collect source-bound module/product facts before
publishing and pass those facts into the release passport:

```js
import { collectModuleBuildFacts, writeBuildFacts } from "@kungfu-tech/buildchain/build-facts";

const fact = collectModuleBuildFacts({ moduleId: "native-core" });
writeBuildFacts({ fact, output: ".buildchain/facts/native-core.json" });
```

Web-surface validation stays in core because both local scripts and GitHub
Actions need the same fail-closed interpretation of project, channel, deploy,
retention, and staging security declarations.

README badge consumers should import the public badge subpath and treat
Markdown as a projection of the returned facts:

```js
import { collectBadgeBundleFacts, renderBadgeBundleBlock } from "@kungfu-tech/buildchain/badges";

const facts = await collectBadgeBundleFacts({ cwd: process.cwd() });
const markdown = renderBadgeBundleBlock(facts);
```

The older `@kungfu-tech/buildchain/readme-badges` subpath remains available for
callers that need the full README badge surface instead of the default
KFD-1 / KFD-2 / KFD-3 / Release Passport bundle.
