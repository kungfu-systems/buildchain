---
status: draft
period: ongoing
theme: buildchain-release-tail-provider-plane
doc_type: architecture
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-09-20
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-20
  visible_context: Buildchain release-tail declaration, provider adapters, durable transaction implementation, CLI, Action, reusable workflow, tests, and frozen consumer inventory.
  invisible_context_boundary: Did not read credentials, private provider state, signed URLs, unpublished release assets, or production receipts.
---

# Declarative release-tail provider plane

Buildchain owns release effects and their readback. Consumers declare product
artifacts and publication targets in schema-2 TOML, then use the shared normal
and exact-attempt recovery callers. They do not maintain release-tail provider
bindings, transaction payloads, state artifacts or additional workflows.

## Consumer entry points

- `buildchain.yml` invokes `public-ops-pipeline.yml@v4`.
- `buildchain-recover.yml` invokes `public-ops-recover.yml@v4`.

Generate both through [init](getting-started.md). Request publication through a
protected channel PR; recover an interrupted operation by its exact attempt.
The runtime owns source, artifact and provider-effect selection.

## Internal provider implementation

The Node modules `release-tail-provider-plane` and `release-tail-provider-adapters`,
the `release-tail` diagnostic CLI, `actions/release/tail/settle`, and the internal
`.release-tail.yml` workflow implement and inspect bounded release transactions.
They are maintenance interfaces, not additional consumer wiring.

The internal reusable workflow is permission-neutral. Its owning runtime job
supplies explicit provider permissions, while rehearsal runs retain read-only
permissions and no production execution authority. A rehearsal or simulation
result cannot authorize publication. Provider credentials remain separate from
consumer commands and serialized transaction data.

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

Buildchain uses the same generated normal and recovery callers as other consumers.
The published runtime selects its internal publication jobs, binds their source
and artifacts, and performs provider readback. Its product publisher is
`.release-pipeline-products.yml`; consumer YAML does not call that component.

Completed-publication recovery verifies the existing publication and immutable
assets before continuing. A provider failure cannot select replacement product
bytes or a different source. Internal transaction fixtures and retained historical
receipts remain evidence of their original execution, not extra current callers.
