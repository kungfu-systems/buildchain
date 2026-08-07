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
- Action: `kungfu-systems/buildchain/actions/release-tail@<exact-ref>`.
- reusable workflow: `kungfu-systems/buildchain/.github/workflows/release-tail.yml@<exact-ref>`.

The Action is the provider-executing entry point. The CLI compiles, initializes,
inspects, verifies, and diagnoses bounded v3 compatibility using the same core
transaction format. The reusable workflow checks out an exact Buildchain ref
and invokes the packaged Action; callers cannot inject an execution command.

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

## Buildchain self-dogfood route

Buildchain self-release calls the same public reusable workflow coordinate as a
consumer:

```text
kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@f28ce21efd8d05b25969ef708edc678d17619b6e
```

The caller pins the public router and runtime to the same exact implementation
SHA. Its internal alpha shell remains on the named train, so automatic
`workflow_run` publication uses the immutable-router path without a manual
runtime override. For alpha self-release, the promotion Action materializes the
sealed GitHub Release asset declaration, executes it through this provider
plane, and retains the
declaration root, transaction root, state root, receipt roots, controller
receipt, and route-parity evidence. The legacy GitHub Release helper is not a
fallback when `declarative-release-tail` is enabled; a provider or readback
failure fails the authoritative run.

Stable routing remains on the existing `v3` shell and does not receive the new
alpha-train input. Stable cutover is a separate gate after prerelease dogfood.

## v3 compatibility boundary

`release-tail compat --hooks-json <json-or-path>` recognizes only the frozen v3
hook names. It emits diagnostics for enumerated legacy callers and rejects any
new command-bearing release-tail field. Compatibility never converts legacy
shell into a new provider plugin and never reinterprets settled release history.
