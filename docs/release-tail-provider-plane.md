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
  `release-tail-provider-adapters`, `release-tail-compatibility`, and
  `publication-rehearsal-runtime`.
- CLI: `buildchain release-tail plan|init|status|verify|compat|rehearse`.
- Action: `kungfu-systems/buildchain/actions/release-tail@<exact-ref>`.
- reusable workflow: `kungfu-systems/buildchain/.github/workflows/release-tail.yml@<exact-ref>`.

The CLI and Action both invoke the public publication rehearsal runtime over
the same core transaction implementation. The Action is a thin provider
transport wrapper; callers cannot inject an execution command or runner state.

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

For complete local release semantics, use the exact capsule command in
[`publication-rehearsal.md`](publication-rehearsal.md). Simulation and replay
exercise planning, validation, transaction, retry, and evidence without
claiming external provider truth. Provider execution belongs in the Action or
reusable workflow so token handling and transport capabilities remain explicit.
Retain the state and rehearsal evidence artifacts.

## v3 compatibility boundary

`release-tail compat --hooks-json <json-or-path>` recognizes only the frozen v3
hook names. It emits diagnostics for enumerated legacy callers and rejects any
new command-bearing release-tail field. Compatibility never converts legacy
shell into a new provider plugin and never reinterprets settled release history.
