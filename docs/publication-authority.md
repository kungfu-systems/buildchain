---
status: draft
period: ongoing
theme: sealed-publication-authority
doc_type: protocol
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-07-14
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-14
  limits: Live provider configuration must be re-audited; no credential values are represented.
---

# Sealed Publication Authority

Buildchain publication authority is a closed-world, fail-closed protocol. It does
not mint registry or cloud credentials. It independently verifies whether an
already protected publication job is allowed to request a short-lived provider
credential for one exact product, target, version, channel, and artifact digest.

The machine-readable authority inventory is
`dist/site/publication-authority-registry.json`. Any workflow with a write,
environment, OIDC, cloud credential, registry publish, release, or Git push
signal must have an explicit descriptor. A new authority-bearing workflow that
is absent from the inventory fails site generation. Unknown workflows and every
descriptor not marked `product-publication` are denied product publication.

## Evidence chain

A qualifying admission binds exact source and runtime SHAs; contract, policy,
controller, artifact, runner, and control-plane digests; repository, workflow,
product, target, version, and channel; plus a unique nonce and a lifetime of no
more than 15 minutes.

The independent verifier recomputes every digest and ignores a producer's own
allow/deny conclusion. It rejects an unknown workflow, stale or replayed nonce,
runner downgrade, control-plane drift, source/runtime mismatch, and artifact
substitution. A successful result is a scoped capability receipt, not a bearer
credential.

## Runner and control-plane evidence

Runner evidence uses exactly four classes: `ephemeral`, `reimaged`,
`persistent-measured`, and `unqualified`. The first three require image and
measurement digests; `unqualified` always fails. Provider restrictions still
apply. The external audit records digests and pass/fail status for repository
Actions defaults, protected branch and Environment policy, job-scoped OIDC,
absence of long-lived publication credentials, exact trusted-publisher binding,
token-disable policy, and authorized runner class. Missing facts fail closed.

Evidence publication is a separate authority class and never grants product
publication.

## API and CLI

Use `@kungfu-tech/buildchain/publication-authority` or run:

```bash
buildchain verify publication-admission admission.json \
  --registry-json publication-authority-registry.json \
  --runner-json runner.json \
  --control-plane-audit-json control-plane.json \
  --expected-json expected.json \
  --used-nonce previous-run-nonce \
  --json
```

Provider credential issuance must bind to the same protected workflow and
environment. The Buildchain receipt alone is never sufficient authorization.
