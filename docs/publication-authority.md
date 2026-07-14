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
and control-plane digests; repository, authority workflow, provider publisher
workflow, Environment policy,
product, target, version, and channel; plus a unique nonce and a lifetime of no
more than 15 minutes. Every expected binding is mandatory at verification time;
an omitted expected field is not a wildcard.

The independent verifier recomputes every digest and ignores a producer's own
allow/deny conclusion. It fetches the exact evidence run, validates the actual
release-candidate passport and referenced qualifying controller receipt,
recomputes the Shifu Gate aggregate or explicit consumer-owned no-Gate policy,
recomputes the downloaded artifact manifests, and hashes every declared product
payload file against those manifests. The `.buildchain/` diagnostics envelope is
bound by the manifest digest but excluded from the product-byte set because it can
be finalized after the lifecycle scan. The verifier also compares the PR evidence tree to the
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
declared protected Environment policy or an explicit no-Environment binding,
job-scoped credentials,
absence of long-lived workflow publication credentials, provider authority,
and authorized runner class. Provider modes are `npm-trusted-publisher`,
`github-token`, and `oidc-role`. The OIDC-role mode consumes only a sanitized
provider audit containing a role digest and qualifying decision; raw IAM policy,
tokens, or credentials are rejected. Package-owner, cloud-root, GitHub
administrator, and registry-root credentials remain outside Buildchain's trust
boundary. Missing or unreadable facts fail closed.

An unauthenticated local npm CLI is not evidence that Trusted Publishing is
missing. `npm whoami` reports only the local CLI session and does not report the
OIDC identity that npm creates during `npm publish`. The default read-only audit
therefore binds the exact provider, repository, caller workflow, optional
Environment, job-scoped OIDC permission, and absence of long-lived credentials,
then records `provider-at-transaction`: npm makes the final authorization
decision when `npm publish` exchanges the job's OIDC token. A missing or drifted
trusted-publisher configuration consequently denies the transaction safely; it
is not preflighted through an unrelated long-lived npm login.

An authenticated external auditor can add stronger point-in-time evidence by
supplying sanitized `npm trust list --json` output with `--npm-trust-json`. This
changes the publisher fact to `audited-control-plane`; the workflow never runs
`npm trust list` itself and never receives that auditor's npm credential.

The credential-free collector proves effective Actions and runner scope from
the publication workflow fetched at `--workflow-ref`: explicit read-only
workflow defaults, job-scoped write/OIDC permissions, and an exact GitHub-hosted
runner label. It does not call repository Actions-default or self-hosted-runner
administration endpoints. Branch/ruleset and OIDC subject facts remain live
read-only provider queries. This avoids turning a repository-admin token into a
publication prerequisite.

For non-dry-run workflows, missing admission, runner, control-plane, Gate, or
expected-binding evidence is rejected before Buildchain downloads candidate
artifacts. The denial explicitly records that npm Trusted Publishing and OIDC
were not evaluated, so downstream diagnostics cannot misclassify an admission
assembly failure as an npm authentication failure.

Buildchain's own `workflow_run` promotion lane may assemble those inputs only
for `kungfu-systems/buildchain`. It downloads the exact prior RC passport,
summary, referenced controller receipt, manifests, and product payloads; proves
the admitted channel commit has the same Git tree as the RC; performs the live
read-only control-plane audit; records the GitHub-hosted job as ephemeral runner
provenance; and creates an explicit Buildchain-owned no-Gate decision. The
independent verifier then recomputes every receipt and payload digest exactly as
it does for externally supplied admission. The self-assembly mode rejects other
repositories, unknown refs, non-exact source SHAs, and any caller other than
`.github/workflows/buildchain-ref-promotion.yml`. Manual apply and external
consumer workflows still require their own explicit admission inputs.

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
  --branch dev/v2/v2.12 \
  --workflow .github/workflows/release-candidate-promote.yml \
  --workflow-ref <exact-buildchain-sha> \
  --publisher-workflow .github/workflows/buildchain-ref-promotion.yml \
  --job promote \
  --environment none

# Optional stronger external evidence; generate the JSON outside the workflow.
buildchain audit publication-control-plane \
  --repository kungfu-systems/buildchain \
  --branch dev/v2/v2.12 \
  --workflow .github/workflows/release-candidate-promote.yml \
  --publisher-workflow .github/workflows/buildchain-ref-promotion.yml \
  --job promote \
  --environment none \
  --npm-trust-json sanitized-npm-trust.json

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

The authority workflow identifies the reusable implementation that performs the
publication job. The publisher workflow identifies the caller filename bound by
the provider's trusted-publisher policy; these identities are deliberately
separate. `--environment none` is an explicit assertion that the job declares no
GitHub Environment and the provider policy has no Environment restriction. A
named Environment must exist, be protected, and be declared by the job. The
Buildchain receipt alone is never sufficient authorization.

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
