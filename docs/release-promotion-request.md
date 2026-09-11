---
status: draft
period: ongoing
theme: release-promotion-api
doc_type: manual
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-11
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-09
  visible_context: Current promotion workflows, JSON schemas, request binding implementation and focused tests.
  invisible_context_boundary: No alpha publication or production promotion was performed.
---

# Release promotion request

`public-release-promote.yml` is the public API. Its single `request-json` input
uses [`promotion-request-v1.schema.json`](../contracts/promotion-request-v1.schema.json).
The schema owns field types and defaults. Unknown fields, stringified booleans,
historical command hooks and caller-supplied internal authority fields are rejected.

```yaml
jobs:
  promote:
    uses: kungfu-systems/buildchain/.github/workflows/public-release-promote.yml@v4-alpha
    with:
      request-json: |
        {
          "schema": "buildchain.promotion-request/v1",
          "target-ref": "alpha/v4/v4.1",
          "target-sha": ${{ toJSON(github.sha) }},
          "dry-run": true
        }
    secrets: inherit
```

Serialize dynamic values with `toJSON` so quotes, newlines, numbers and booleans
retain their original meaning. Permissions remain an explicit caller responsibility;
an input cannot grant a job credentials or provider authority.

The public workflow selects one runtime through the central runtime entry, admits
the consumer source and constructs the internal
[`promotion-invocation-v1.schema.json`](../contracts/promotion-invocation-v1.schema.json)
document. QUALIFY, APPLY and SETTLE prepare that selected runtime and retain their
separate job permissions. Later nodes validate source, artifact and publication
evidence without comparing Buildchain SHAs.

Buildchain dogfood and external consumers use the same `@v4` or `@v4-alpha`
public entry. The entry commit owns the API shell; the selected runtime owns
business actions, modules and resources. A transient `runtime-ref` can select a
repaired train while preserving the original publication source and evidence.
See [Runtime entry](runtime-entry.md) for selection precedence and recovery.
