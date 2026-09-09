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

# Code organization

Buildchain 4.1 uses responsibility layers, then capability directories. The
reusable workflow is the primary consumer API. This development line is
`4.1.0-alpha.0`; these changes do not themselves publish an alpha release.

```text
.github/workflows/                 Consumer APIs and hosted job topology
  public-*.yml, build.yml           Public reusable contracts
  .*.yml                           Internal reusable job components
  self-*.yml                       Buildchain event callers

actions/<capability>/<node>/        Composite or Node action adapter
  action.yml                       Node inputs, outputs and external actions
  index.js                         Minimal Node action entry, when needed
  dist/                            Generated Node action bundle

packages/core/<capability>/         JavaScript business modules and provider IO
  nodes/                           Workflow node entry adapters
  cli/                             CLI command handlers
  commands/                        Executable capability tools
  <responsibility>/                Related business modules

crates/buildchain-domain-contracts/ Rust domain decisions and state contracts
crates/buildchain-host-bridge/      Native Node host boundary
contracts/                         Public schemas and contract fixtures
architecture/                      Ownership, topology and enforced budgets
bin/                               Minimal CLI entry
scripts/                           Repository generation and verification tools
tests/                             Behavioral, contract and failure-path tests
```

The closed capability vocabulary is declared in
[`code-layout.json`](../architecture/code-layout.json). A workflow owns runner,
job dependencies, permissions, environments and semantic node order. It does
not embed business scripts. A composite owns GitHub step composition, including
checkout, artifact transfer and external actions. JavaScript owns the node's
business implementation; Rust/WASM retains the existing authoritative domain
implementations. No JavaScript replacement is permitted for a Rust-owned domain.

Capabilities already implemented in JavaScript remain explicitly declared as
such in the state-machine manifest. Moving a file does not qualify a new Rust
writer or transfer production authority.

The development delivery API has six semantic nodes: `source`, `reserve`,
`native`, `qualify`, `settle`, and `land`, under `actions/dev-delivery/`.
Buildchain invokes this public delivery workflow from the same source commit, so
its workflow, action paths and runtime modules share one implementation identity.
The native node runs in separate hosted jobs where the trust boundary requires
process and credential isolation. A semantic node need not mean one runner.

Promotion enters the public workflow through one closed `request-json` contract,
then QUALIFY, APPLY and SETTLE. Paper owns its publication plan and final receipt;
the candidate build receipt is an input to that publication proof.

Dependencies point down the layers. Core modules cannot import actions,
workflows, CLI entries or repository tooling. A moved business implementation
has one current owner; imports bind directly to that owner. Retired aliases,
compatibility wrappers, command-hook fallbacks and old execution switches are
removed. Immutable release and qualification evidence remains historical data.

`pnpm run check:layout` checks the closed directory vocabulary, action registry,
entry sizes, node budgets, import direction and reachable JSON input fields.
Workflows allow at most eight steps per job and no inline business scripts;
composites allow at most 160 implementation lines and twelve inline script lines.
The maintainability and internal architecture gates additionally enforce module,
function, dependency and test ownership budgets. Required review covers those
gates as well as their manifests.

After changing an entry or module, regenerate workflows, public references and
site facts, rebuild Node action bundles, and run `pnpm run check`. Distribution
and a clean consumer must resolve the same declared implementation files.
