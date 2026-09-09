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
last_reviewed: 2026-09-09
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

The public workflow resolves identities, admits the consumer and calls the current
publisher component. The admission node creates one complete internal
[`promotion-invocation-v1.schema.json`](../contracts/promotion-invocation-v1.schema.json)
document containing the exact router, publisher, runtime, contract lock and any
independently authorized transient runtime selection. The component verifies that
document before loading the selected runtime, then runs QUALIFY, APPLY and SETTLE
with their separate job permissions.

Consumer repositories adopt this API when the selected distribution channel
contains it. Development self-calls use the source-owned public entry so that
the definition and request contract come from the same reviewed commit. This
development arrangement does not move a floating tag or publish an alpha package.

The source-owned promotion API uses the caller's exact defining commit. Its
consumer lock roots describe published external dependencies; they do not claim
that the new local API is compatible with a previously published workflow. The
source-owned path authenticates Git content instead of granting a historical
compatibility exception. External floating calls still require selected-lock
compatibility with the resolved public workflow.
