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

actions/<capability>/<group>/<operation>/
                                   Composite or Node action adapter
  action.yml                       Node inputs, outputs and external actions
  index.js                         Minimal Node action entry, when needed
  dist/                            Generated Node action bundle

packages/core/<capability>/         JavaScript business modules and provider IO
  <responsibility>/                Named business transactions and adapters
  cli/                             CLI command handlers
  commands/                        Executable capability tools

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

Action ownership is declared in
[`action-taxonomy.json`](../architecture/action-taxonomy.json), including every
allowed group and operation. The directory has three meaningful levels:
capability, responsibility group, and reusable operation. It does not contain
one directory per workflow or one action per old script step.

| Capability                 | Responsibility groups and examples                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `build`                    | Lifecycle, source qualification, artifacts, signing, credentials, gates, standalone binaries, demos and Stage Capsules |
| `dev-delivery`             | Candidate admission, native execution, Warrant transitions and protected queue landing                                 |
| `release`                  | Source promotion, candidate recovery, release lines, propagation, resealing and tail settlement                        |
| `publication`              | Candidate evidence, authority admission, npm, binary publication and terminal settlement                               |
| `governance`               | Repository audits, incidents, alpha and stable candidate policy                                                        |
| `providers`                | GitHub credentials and API access, source checkout, AWS access, artifact transfer and signing providers                |
| `runtime`                  | Exact runtime selection, environment, locked dependencies and toolchains                                               |
| `observability`            | Controller evidence and immutable evidence retention                                                                   |
| `paper`, `web`, `adoption` | Product-specific publication, deployment and consumer qualification                                                    |
| `workflow`                 | Event admission, Bootstrap and the admitted candidate engine                                                           |

For example, `actions/release/line/open` composes shared source, credential and
line actions. Its JavaScript transaction coordinates line policy and provider
readbacks through named modules. `actions/providers/github/token` is shared
where an App token and fallback policy are needed; ordinary JSON parsing is a
module function, not a separate action.

A Node action has an explicit input/output contract and one named entry API.
The adapter parses inputs and emits outputs; the core transaction owns ordering,
validation, failure evidence and recovery. Modules import other modules directly.
They do not invoke another action bundle or a generic script executor. Where an
external action requires a separate GitHub step, the composite owns that step;
pure internal operations stay inside the transaction.

Capabilities already implemented in JavaScript remain explicitly declared as
such in the state-machine manifest. Moving a file does not qualify a new Rust
writer or transfer production authority.

The development delivery API has six semantic nodes: source admission,
reservation, native execution, qualification, settlement, and landing. Its
actions are grouped under `dev-delivery/candidate`, `dev-delivery/native`,
`dev-delivery/warrant`, and `dev-delivery/queue`.
Buildchain invokes this public delivery workflow from the same source commit, so
its workflow, action paths and runtime modules share one implementation identity.
The native node runs in separate hosted jobs where the trust boundary requires
process and credential isolation.
Dispatch carries exact source-run coordinates and content roots. When the path
array is omitted, source admission reconstructs the complete Git diff from the
successful PR run and verifies its source identity root. Later nodes read the
verified source proof, so large changes do not exceed provider dispatch limits. A semantic node need not mean one runner.

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
composites allow at most 160 implementation lines and only `uses` steps.
Neither workflow nor composite YAML may contain `run`, `shell`, or
`with.script`. Node action entries contain at most twelve lines.
The maintainability and internal architecture gates additionally enforce module,
function, dependency and test ownership budgets. Required review covers those
gates as well as their manifests.

After changing an entry or module, regenerate workflows, public references and
site facts, rebuild Node action bundles, and run `pnpm run check`. Distribution
and a clean consumer must resolve the same declared implementation files.
