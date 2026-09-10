---
status: draft
period: 2026-08-07
theme: buildchain-release-tail-provider-plane
doc_type: architecture
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-07
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-07
  visible_context: Buildchain release-tail declaration, provider adapters, durable transaction implementation, CLI, Action, reusable workflow, tests, and frozen consumer inventory.
  invisible_context_boundary: Did not read credentials, private provider state, signed URLs, unpublished release assets, or production receipts.
---

# Declarative release-tail provider plane

Buildchain owns the final release tail as one versioned transaction. A consumer
supplies a sealed capability declaration and data-only provider bindings; it
does not supply shell, JavaScript, executable paths, callbacks, or plugins.
The frozen boundary and migration inventory remain in
[`release-tail-contract.md`](./release-tail-contract.md).

## Public entry points

- Node: `@kungfu-tech/buildchain/release-tail-provider-plane`,
  `release-tail-provider-adapters`, and `release-tail-compatibility`.
- CLI: `buildchain release-tail plan|init|status|verify|compat`.
- Action: `kungfu-systems/buildchain/actions/release/tail/settle@<exact-ref>`.
- reusable workflow: `kungfu-systems/buildchain/.github/workflows/public-release-tail.yml@<exact-ref>`.

The Action is the provider-executing entry point. The CLI compiles, initializes,
inspects, verifies, and diagnoses bounded v3 compatibility using the same core
transaction format. The reusable workflow checks out an exact Buildchain ref
and invokes the packaged Action; callers cannot inject an execution command.

The reusable workflow is permission-neutral: it inherits the calling job's
GitHub token permissions and never elevates them. A rehearsal caller can remain
`contents: read` and must pass `execute: false`. An effectful production caller
owns and declares its provider authority explicitly:

<!-- release-tail-production-caller-contract -->

```yaml
name: Production release tail

on:
  workflow_dispatch:

jobs:
  release-tail:
    permissions:
      contents: write
    uses: kungfu-systems/buildchain/.github/workflows/public-release-tail.yml@<exact-buildchain-sha>
    with:
      buildchain-ref: <exact-buildchain-sha>
      declaration-path: .buildchain/release-tail/declaration.json
      provider-bindings-path: .buildchain/release-tail/provider-bindings.json
      execute: true
```

Omitting caller write authority cannot be repaired by the reusable workflow;
GitHub rejects or constrains the call before provider execution. `execute:
false` remains a plan/rehearsal boundary and does not authorize production
mutation even when a caller token has broader ambient permissions.

## Inputs and secrets

The declaration follows
[`release-tail-capabilities-v1.schema.json`](../contracts/release-tail-capabilities-v1.schema.json).
Provider file and endpoint bindings follow
[`release-tail-provider-bindings-v1.schema.json`](../contracts/release-tail-provider-bindings-v1.schema.json).
Bindings contain paths, asset names, HTTP methods, and evidence input paths.
GitHub and HTTP bearer tokens are separate secret inputs and never enter the
effect plan, checkpoint, observation, receipt, or output.

## Transaction semantics

Declaration parsing rejects unknown fields, identity drift, unsupported
capability/adapter pairs, unbounded retries, and executable keys recursively.
Compilation produces deterministic effect and plan roots. Execution persists
one atomic checkpoint containing ordered operations, rooted observations, and
rooted receipts.

For each effect Buildchain performs readback before mutation, applies at most
the declared bounded local attempts, then performs readback again. Buildchain
core alone compares the declared subject and target roots and chooses
`complete`, `blocked`, `repair-required`, or `terminal-failure`. An adapter can
report observed, absent, transient, or conflict; it cannot declare success.

The built-in adapters are:

- `github-release-assets`: exact GitHub Release tag and immutable named assets;
- `signed-static-channel`: rooted HTTPS JSON channel commit with optional CAS;
- `site-release-activation`: rooted HTTPS activation and public readback;
- `activation-receipt-projector`: deterministic released-evidence synthesis.

Duplicate execution is a readback no-op. A lost mutation response is recovered
by the next local readback. A stale rooted object requires repair, immutable
provider collision is terminal, and credential/network uncertainty remains a
bounded blocked result rather than synthesized success.

## Local verification

```bash
buildchain release-tail plan --declaration release-tail.json
buildchain release-tail init --declaration release-tail.json --state .buildchain/release-tail/state.json
buildchain release-tail verify --state .buildchain/release-tail/state.json
```

Provider execution belongs in the Action or reusable workflow so token handling
and provider permissions remain explicit. Retain the state artifact: it is the
resume boundary and evidence source, not a disposable log.

## Buildchain self-promotion route

Buildchain invokes `./.github/workflows/public-release-promote.yml` at the same
commit as its caller. Admission independently verifies the defining repository,
exact committed workflow bytes and both consumer lock roots. External consumers
use the public floating-channel API after publication. See
[Promotion request](release-promotion-request.md).

The promotion action executes one declaration-driven GitHub Release transaction.
Its plan, provider observations and receipts bind the exact subject and asset
roots. A completed-transaction recovery explicitly verifies the existing public
Passport and immutable assets before reusing or repairing evidence. A provider
failure cannot select a different publication implementation.

Release metadata follows the declared tag and channel. The old mode selector and
custom title/notes ports are removed. Retired shell-hook compatibility commands
are absent; the current typed request rejects undeclared fields.
