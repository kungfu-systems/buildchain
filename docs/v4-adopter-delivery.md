---
status: preview
period: 2026-09-10
theme: buildchain-adopter-delivery
doc_type: product-manual
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
  visible_context: Current adopter runtime, public workflow, composite actions and local execution tests.
  invisible_context_boundary: No hosted cross-platform execution or publication was performed for this documentation.
---

# Internal adopter qualification

The internal `.build-adopter-qualification.yml` component owns its platform
qualification jobs. `actions/adoption` owns admission, conformance and
reconciliation; `packages/core/adoption` owns driver coordination and readback.
Consumers use the shared normal/recovery pair and do not add an adopter-specific
caller or qualification request to their TOML. See [Getting started](getting-started.md).

## Driver contract

The [input schema](../contracts/v4-adopter-delivery-v1.schema.json) requires an
exact protocol driver and artifact profile. Built-in driver selectors are
`json-assertion` and `kfd-category`; artifact profiles are `git-commit` and
`package`. A selector must match the identity in the request.

Import the driver interface from `@kungfu-tech/buildchain/adopter-delivery-gate`
and the current convenience runtime from `@kungfu-tech/buildchain/adopter-delivery`.
The runtime evaluates declarations and independently recomputes readback. Its
result grants no provider, signing, publication or release authority.

```sh
buildchain adopter-delivery run \
  --input contracts/adopter-delivery/input.json \
  --output .buildchain/adopter-delivery/readback.json

buildchain adopter-delivery verify \
  --input contracts/adopter-delivery/input.json \
  --readback .buildchain/adopter-delivery/readback.json
```

Unknown selectors, mismatched protocol versions, missing readback and changed
rooted evidence fail. The API has two operations: `run` and `verify`.

## Configuration

The closed JSON input owns `driverSelector`, `artifactProfileSelector`, `request`
and `context`. The internal component's `input-path` names that document; CLI
`--input`, `--readback` and `--output` arguments locate the request and evidence.
Build configuration contains no duplicate Adopter Delivery declaration.

For internal qualification, paths stay inside the admitted source. Component inputs name `consumer`
and `input-path`. External qualification additionally requires the complete
`consumer-repository`, exact `consumer-ref` and `invocation-source-path` tuple.
The admission node verifies the checked-out source and defining runtime before
executing policy. Conformance jobs use the admitted source SHA.

## Qualification evidence

Each platform runs the current public CLI, rejects a tampered readback, retries
and verifies the final readback. It also runs the independent
`ledger-specification-driver` clean-room test. A report binds the exact runtime
commit, consumer commit and input root to these executed scenarios.

Reconciliation requires exactly one report per declared platform. All reports
use the same runtime; each consumer must use the same source and input across
platforms. Missing, duplicate, inconsistent or modified reports fail.
Qualification has no production, provider or release authority.

The former standalone adopter dogfood caller is historical. Current self product
verification is declared in TOML and runs through the normal pipeline.
Historical parity research remains historical evidence; it does not create an
additional consumer public API or prove current hosted qualification.
