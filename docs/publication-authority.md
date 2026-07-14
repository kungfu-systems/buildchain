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

A qualifying admission binds exact source and runtime SHAs; contract, consumer
policy, qualifying controller receipt, Shifu/Gate aggregate, artifact, runner,
and control-plane digests; repository, workflow, protected Environment,
product, target, version, and channel; plus a unique nonce and a lifetime of no
more than 15 minutes. Every expected binding is mandatory at verification time;
an omitted expected field is not a wildcard.

The independent verifier recomputes every digest and ignores a producer's own
allow/deny conclusion. It fetches the exact evidence run, validates the actual
release-candidate passport and referenced qualifying controller receipt,
recomputes the Shifu Gate aggregate or explicit consumer-owned no-Gate policy,
recomputes the downloaded artifact manifests, and hashes every candidate payload
file against those manifests. It also compares the PR evidence tree to the
admitted post-merge source commit tree. It rejects an unknown
workflow, stale or replayed nonce, runner downgrade, control-plane drift,
source/runtime mismatch, and artifact substitution. A successful result is a
scoped capability receipt, not a bearer credential.

## Runner and control-plane evidence

Runner evidence uses exactly four classes: `ephemeral`, `reimaged`,
`persistent-measured`, and `unqualified`. Ephemeral runners also record their
job-isolation boundary. Reimaged and persistent runners qualify only when a
clean baseline is proven and baseline, toolchain, cache-contract, and task-
isolation digests are all present. Otherwise they still emit diagnostic
evidence with `qualificationStatus = unqualified`, but cannot receive a product
capability.

The external audit records digests and pass/fail status for repository Actions
defaults, classic branch protection or an active matching repository ruleset,
protected Environment policy, job-scoped credentials,
absence of long-lived workflow publication credentials, provider authority,
and authorized runner class. Provider modes are `npm-trusted-publisher`,
`github-token`, and `oidc-role`. The OIDC-role mode consumes only a sanitized
provider audit containing a role digest and qualifying decision; raw IAM policy,
tokens, or credentials are rejected. Package-owner, cloud-root, GitHub
administrator, and registry-root credentials remain outside Buildchain's trust
boundary. Missing or unreadable facts fail closed.

Evidence publication is a separate authority class and never grants product
publication.

## API and CLI

Use `@kungfu-tech/buildchain/publication-authority` or run:

```bash
buildchain verify publication-admission admission.json \
  --registry-json publication-authority-registry.json \
  --runner-json runner.json \
  --control-plane-audit-json control-plane.json \
  --publication-evidence-json publication-evidence.json \
  --expected-json expected.json \
  --used-nonce previous-run-nonce \
  --json
```

The read-only live collector defaults to npm trusted publishing. Other product
providers select an explicit adapter:

```bash
buildchain audit publication-control-plane \
  --repository kungfu-systems/buildchain \
  --branch release/v2/v2.12 \
  --workflow .github/workflows/.binary-release-assets.yml \
  --job publish \
  --environment buildchain-release-assets \
  --publisher-mode github-token

buildchain audit publication-control-plane \
  --repository OWNER/CONSUMER \
  --workflow-repository kungfu-systems/buildchain \
  --branch main \
  --workflow .github/workflows/.web-surface.yml \
  --job production-apply \
  --environment production \
  --publisher-mode oidc-role \
  --provider-audit-json sanitized-oidc-role-audit.json
```

Provider credential issuance must bind to the same protected workflow and
environment. The Buildchain receipt alone is never sufficient authorization.

## Publication lanes

`Binary Distribution` is evidence-only. It builds platform archives and a
release evidence bundle with read-only repository permissions. GitHub Release
asset writes live in `Binary Release Assets`, which downloads an exact prior
evidence run, verifies its bundle digest against the sealed capability, and is
the only binary job with `contents: write` in the protected
`buildchain-release-assets` Environment.

The npm/promotion, paper, binary-release, and web-production lanes all depend on
the independent verifier. Preview, staging, build, source-check, controller,
and failure-evidence lanes do not inherit product publication capability.
