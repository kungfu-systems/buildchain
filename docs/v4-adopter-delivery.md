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
last_reviewed: 2026-09-10
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-10
  visible_context: Current adopter runtime, public workflow, composite actions and local execution tests.
  invisible_context_boundary: No hosted cross-platform execution or publication was performed for this documentation.
---

# Public Adopter Delivery

The public entry is `kungfu-systems/buildchain/.github/workflows/public-build-adopter-qualification.yml`.
Consumers call its floating `@v4` or `@v4-alpha` channel and retain matching dual
contract locks. The workflow owns the Linux, macOS and Windows job matrix;
`actions/adoption` owns admission, conformance and reconciliation;
`packages/core/adoption` owns driver coordination and exact readback.

## Public contract

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
and `context`. The public workflow's `input-path` names that document; CLI
`--input`, `--readback` and `--output` arguments locate the request and evidence.
Build configuration contains no duplicate Adopter Delivery declaration.

Paths must stay inside the consumer repository. Workflow inputs name `consumer`
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

Buildchain's [thin dogfood caller](../.github/workflows/self-build-adopter-dogfood.yml)
uses the same public entry. Historical parity research remains historical
evidence; current qualification does not download old Buildchain packages or
require an old release's bootstrap lineage.
