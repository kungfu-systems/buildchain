---
status: active
period: ongoing
theme: buildchain-layered-architecture
doc_type: implementation-guide
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-10
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-10
  visible_context: Buildchain 4.1 source, architecture registries and local validation.
  invisible_context_boundary: No unpublished release or external consumer qualification is claimed.
---

# Buildchain Core

Core contains JavaScript business logic and provider IO, grouped by the closed
capabilities in [`architecture/code-layout.json`](../../architecture/code-layout.json).
See [Code organization](../../docs/code-organization.md) for the complete layout.

Workflow node adapters live in each capability's `nodes/`, command-line handlers
in `cli/`, and executable capability tools in `commands/`. Related domain modules
have responsibility names. The root `index.js` is the public API aggregation;
implementation modules import their actual owner directly.

Core cannot depend on `actions`, `.github/workflows`, `bin`, or repository
`scripts`. Rust-owned domain decisions are called through the existing WASM/host
boundary and have no JavaScript fallback.

Use the generated [Node API Reference](../../docs/node-api-reference.md) for
current package subpaths, symbols and signatures. For example:

```js
import { createBuildchainLogger } from "@kungfu-tech/buildchain/logging";

const logger = createBuildchainLogger({ source: "user", component: "build" });
await logger.span("package", { phase: "package" }, packageArtifacts);
```

The CLI is the adapter for shells and non-JavaScript tools. Core modules can be
used directly by JavaScript callers. Both paths share the same implementations.
