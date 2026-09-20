---
status: draft
period: ongoing
theme: internal-release-promotion-request
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-20
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-20
  visible_context: Current workflow taxonomy, shared consumer entries, internal promotion components and request schemas.
  invisible_context_boundary: This source documentation does not claim a new hosted publication or external consumer migration.
---

# Internal release promotion request

Consumers declare products and legal channel routes in
`.buildchain/buildchain.toml`. The generated `buildchain.yml` caller invokes
`public-ops-pipeline.yml`; a channel PR expresses release intent. Consumers do
not construct a promotion request or add a promotion workflow. See the
[Golden Path](getting-started.md) for the shared normal and recovery entries.

## Internal schemas and components

The advanced promotion implementation retains
[`.release-candidate-promote.yml`](../.github/workflows/.release-candidate-promote.yml)
and [`.release-promote.yml`](../.github/workflows/.release-promote.yml) as
internal components. Their `request-json` transport is an implementation
boundary, not a consumer configuration extension.

[`promotion-request-v1.schema.json`](../contracts/promotion-request-v1.schema.json)
owns the internal request field types and defaults. Unknown fields,
stringified booleans, historical command hooks and unadmitted authority fields
are rejected. The request binder constructs a normalized
[`promotion-invocation-v1.schema.json`](../contracts/promotion-invocation-v1.schema.json)
document. QUALIFY, APPLY and SETTLE retain separate jobs and permissions.
These internals must not be copied into consumer YAML, TOML, or helper scripts.

## Runtime and recovery

The public entry resolves one runtime. Its business jobs use that selected
runtime while retaining exact source, artifact and publication evidence.
Buildchain self consumption uses the same generated caller pair and runtime
selection contract as other repositories.

Recovery goes through `buildchain-recover.yml`, which calls
`public-ops-recover.yml`. The caller supplies the exact attempt and, only when
needed, a transient repaired runtime. The retained attempt owns source,
artifacts, transaction and provider effects; recovery inputs cannot replace
those identities. See [Runtime entry](runtime-entry.md).

The retired `public-release-promote.yml` path is not an alias in the current
contract. Historical receipts and published bytes keep their original paths;
new consumers use the shared pipeline entry after its published qualification.
