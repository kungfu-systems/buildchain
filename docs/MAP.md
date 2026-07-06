# Documentation Map

Start here. Find the question you have; follow it to the document that answers
it. This map is meant to be readable by both a person skimming for the right doc
and an agent grounding a specific claim.

Each row carries a **plane** - *why* (intent / rationale), *verify* (trust the
running artifact), *use* (consume / extend) - and a **status**:

- `stable` - current and holds.
- `draft` - exists, rough or incomplete.
- `to write` - planned; the material exists but is not yet a single doc.
- `retired` - intentionally not part of the active Buildchain v2 surface.

## Capability Coverage

This package should be usable by an agent from the npm artifact alone. The
machine-readable `dist/site/` bundle is the first fact source; the Markdown
manuals explain those facts and give operator examples.

| Capability | Machine-readable entry | Manual entry |
| --- | --- | --- |
| KFD-1 / KFD-2 / KFD-3 release-passport gates | `dist/site/kfd-claims.json`, `dist/site/buildchain-contract.json`, `dist/site/artifact-schemas.json` | [`release-passport.md`](release-passport.md) |
| Floating `@v2` drift detection and compatibility issues | `dist/site/buildchain-contract.json` | [`reusable-build-surface.md`](reusable-build-surface.md#floating-ref-contract-lock) |
| npm publish transactions, evidence, dist-tags, and recovery | `dist/site/release-model.json`, `dist/site/artifact-schemas.json` | [`publish-transaction.md`](publish-transaction.md) |
| GitHub Release passport/evidence publication | `dist/site/release-model.json`, `dist/site/artifact-schemas.json` | [`release-governance.md`](release-governance.md), [`release-candidate.md`](release-candidate.md) |
| release propagation for package/site chains | `dist/site/release-model.json` | [`release-propagation.md`](release-propagation.md) |
| Buildchain CLI manual | `dist/site/cli-registry.json`, `dist/site/manual-registry.json` | [`cli.md`](cli.md) |
| Node API / package exports | `dist/site/node-api-registry.json`, `dist/site/release-provenance.json` | [`cli.md`](cli.md#node-api-and-package-exports) |

`dist/site/kfd-claims.json` is generated from
`packages/core/buildchain-kfd-claims.js`. Treat that module and JSON file as the
source claim registry; this map and the manuals explain those claims but do not
replace them.

## Map

| Your question | Document | Plane | Status |
| --- | --- | --- | --- |
| What is Buildchain, in one idea? | [`../README.md`](../README.md) | - | stable |
| Why is Buildchain a Release Passport mechanism rather than a generic workflow collection? | [`product-mechanism.md`](product-mechanism.md) | why | stable |
| How do agents and contributors enter this repo? | [`../AGENTS.md`](../AGENTS.md) + [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | use | stable |
| How do I install a standalone binary or npm package? | [`install.md`](install.md) | use | stable |
| How do I run the `buildchain` CLI? | [`cli.md`](cli.md) | use | stable |
| How do I import Buildchain toolkit APIs from JavaScript build code? | [`toolkit-observability.md`](toolkit-observability.md) + [`../packages/core/README.md`](../packages/core/README.md) | use | stable |
| How do I initialize a new repository? | [`cli.md`](cli.md) + [`lifecycle-protocol.md`](lifecycle-protocol.md) | use | stable |
| Why does Buildchain use branch-driven release governance? | [`release-governance.md`](release-governance.md) | why | stable |
| How do protected dev branches and scheduled ready-PR merging work? | [`release-governance.md`](release-governance.md#protected-dev-branches) | use | stable |
| How do I run daily, weekly, or monthly repository patrols? | [`release-governance.md`](release-governance.md#buildchain-patrol) | use | stable |
| How does Buildchain decide patch, minor, and major release lines? | [`versioning.md`](versioning.md) | why | stable |
| What exact branch/tag state machine runs on alpha, release, and major gate? | [`release-flow.md`](release-flow.md) | verify | stable |
| What did Buildchain migrate or retire from old action repositories? | [`migration-inventory.md`](migration-inventory.md) | verify | stable |
| What is the active action and workflow source of truth? | [`ownership.md`](ownership.md) | verify | stable |
| How do I declare version files and custom lifecycle commands? | [`lifecycle-protocol.md`](lifecycle-protocol.md) | use | stable |
| How does publish evidence, recovery, and finalization work? | [`publish-transaction.md`](publish-transaction.md) | verify | stable |
| How do I publish or verify release passport artifacts? | [`release-passport.md`](release-passport.md) | use | stable |
| How do I gate release artifacts with KFD-1 contract-world witnesses? | [`release-passport.md`](release-passport.md#kfd-1-contract-world-release-gate) | verify/use | stable |
| How do I audit public KFD-2 release trust claims? | [`release-passport.md`](release-passport.md#kfd-2-release-trust-passport-audit) + [`cli.md`](cli.md) | verify/use | stable |
| How do I gate KFD-3 collaboration-interface releases? | [`release-passport.md`](release-passport.md#kfd-3-collaboration-interface-release-gate) + [`cli.md`](cli.md) | verify/use | stable |
| How do I keep `@v2` floating refs while detecting Buildchain contract drift? | [`reusable-build-surface.md`](reusable-build-surface.md#floating-ref-contract-lock) | verify/use | stable |
| How do I propagate finalized upstream releases to downstream package/site PRs? | [`release-propagation.md`](release-propagation.md) | use | preview |
| How do I prove a PR-stage reusable build is the artifact source promoted later? | [`release-candidate.md`](release-candidate.md) + [`reusable-build-surface.md`](reusable-build-surface.md) | verify | stable |
| Why are binary release assets archived by platform, and where is the single bundle? | [`binary-distribution.md`](binary-distribution.md) | verify | stable |
| How do I add timestamped logs inside build scripts? | [`toolkit-observability.md`](toolkit-observability.md) | use | stable |
| What package-owned facts should buildchain.libkungfu.dev render? | [`site-bundle-contract.md`](site-bundle-contract.md) | use | stable |
| How do I call the reusable build workflow? | [`reusable-build-surface.md`](reusable-build-surface.md) | use | stable |
| How do self-hosted runners relay large artifacts through S3 before GitHub artifacts? | [`reusable-build-surface.md`](reusable-build-surface.md#artifact-transfer-relay) | use | stable |
| How do I validate an unreleased Buildchain runtime train while keeping `@v2`? | [`runtime-train-validation.md`](runtime-train-validation.md) | use | stable |
| How do I deploy a site/app preview, staging, or production surface? | [`web-surface-deployments.md`](web-surface-deployments.md) | use | stable |
| How do I publish observed infrastructure contracts for downstream consumers? | [`infra-contract.md`](infra-contract.md) | use | preview |
| How do I use the active actions directly? | [`../actions/validate-config/README.md`](../actions/validate-config/README.md), [`../actions/run-lifecycle/README.md`](../actions/run-lifecycle/README.md), [`../actions/promote-buildchain-ref/README.md`](../actions/promote-buildchain-ref/README.md), [`../actions/report-buildchain-issue/README.md`](../actions/report-buildchain-issue/README.md) | use | stable |
| How can a consumer workflow report a Buildchain-owned failure back to Buildchain? | [`consumer-issue-reporting.md`](consumer-issue-reporting.md) + [`../actions/report-buildchain-issue/README.md`](../actions/report-buildchain-issue/README.md) | use | stable |
| What do the fixture repositories demonstrate? | [`../fixtures/libnode-shaped/README.md`](../fixtures/libnode-shaped/README.md), [`../fixtures/publish-transaction-shaped/README.md`](../fixtures/publish-transaction-shaped/README.md), [`../fixtures/web-surface-shaped/README.md`](../fixtures/web-surface-shaped/README.md) | verify | stable |
| What license and contribution terms apply? | [`../LICENSE`](../LICENSE) + [`../LICENSE-POLICY.md`](../LICENSE-POLICY.md) | use | stable |
| What trademark, official-service, and provider-compliance boundaries apply? | [`../TRADEMARK.md`](../TRADEMARK.md) + [`../ACCEPTABLE_USE.md`](../ACCEPTABLE_USE.md) + [`../PROVIDER_COMPLIANCE.md`](../PROVIDER_COMPLIANCE.md) | use | stable |
| How do I report a vulnerability? | [`../SECURITY.md`](../SECURITY.md) | use | stable |

## Also asking about

- **ABV / old workflows / old action repositories** -> [`release-governance.md`](release-governance.md)
  and [`migration-inventory.md`](migration-inventory.md).
- **v2 / v2.0 / v2.0-alpha / exact tags / floating tags** ->
  [`release-governance.md`](release-governance.md) and
  [`release-flow.md`](release-flow.md).
- **v2.1 vs v2.2 / when to open a new minor line** ->
  [`versioning.md`](versioning.md).
- **dry-run / what would happen if this channel PR merges** -> [`cli.md`](cli.md)
  and [`release-flow.md`](release-flow.md).
- **protected dev branches / scheduled ready-PR merge / daily-weekly-monthly patrol** ->
  [`release-governance.md`](release-governance.md#protected-dev-branches) and
  [`release-governance.md`](release-governance.md#buildchain-patrol).
- **pnpm / npm / yarn / package-manager adapters** ->
  [`lifecycle-protocol.md`](lifecycle-protocol.md).
- **pip / Conan / CMake / custom commands** -> [`lifecycle-protocol.md`](lifecycle-protocol.md)
  and [`reusable-build-surface.md`](reusable-build-surface.md).
- **libnode / native artifacts / self-hosted runner matrix** ->
  [`reusable-build-surface.md`](reusable-build-surface.md) and
  [`../fixtures/libnode-shaped/README.md`](../fixtures/libnode-shaped/README.md).
- **S3 artifact relay / self-hosted runner artifact transfer** ->
  [`reusable-build-surface.md`](reusable-build-surface.md#artifact-transfer-relay).
- **runtime train validation / temporary `buildchain-ref` override** ->
  [`runtime-train-validation.md`](runtime-train-validation.md) and
  [`reusable-build-surface.md`](reusable-build-surface.md).
- **consumer workflow feedback / automatic Buildchain GitHub issues** ->
  [`consumer-issue-reporting.md`](consumer-issue-reporting.md).
- **PR-stage RC artifacts / promote-only release candidates** ->
  [`release-candidate.md`](release-candidate.md) and
  [`reusable-build-surface.md`](reusable-build-surface.md).
- **infra contract / observed infrastructure outputs / downstream contract propagation** ->
  [`infra-contract.md`](infra-contract.md).
- **standalone binary install / platform archives / GitHub Release bundle** ->
  [`install.md`](install.md), [`binary-distribution.md`](binary-distribution.md),
  and [`release-passport.md`](release-passport.md).
- **Trusted Publishing / npm / publish evidence / recovery** ->
  [`cli.md`](cli.md) and [`publish-transaction.md`](publish-transaction.md).
- **release chains / upstream package as source of truth / site synchronization** ->
  [`release-propagation.md`](release-propagation.md).
- **KFD-1 contract worlds / byte-for-byte release gates** ->
  [`release-passport.md`](release-passport.md#kfd-1-contract-world-release-gate).
- **KFD-2 public release trust claim audit** ->
  [`release-passport.md`](release-passport.md#kfd-2-release-trust-passport-audit).
- **KFD-3 collaboration-interface / agent-facing control surface closure** ->
  [`release-passport.md`](release-passport.md#kfd-3-collaboration-interface-release-gate).
- **floating `@v2` / contract lock / compatible drift issue** ->
  [`reusable-build-surface.md`](reusable-build-surface.md#floating-ref-contract-lock).
- **GitHub Release passport / binary assets / artifact evidence / agent release checks** ->
  [`release-passport.md`](release-passport.md),
  [`binary-distribution.md`](binary-distribution.md), and [`cli.md`](cli.md).
- **Buildchain logging / timestamps / consumer build phase timing** ->
  [`toolkit-observability.md`](toolkit-observability.md) for JavaScript API
  imports, and [`cli.md`](cli.md) for workflow or shell command usage.
- **buildchain.libkungfu.dev / package-owned site facts** ->
  [`site-bundle-contract.md`](site-bundle-contract.md).
- **sites / web previews / staging / production gates** ->
  [`web-surface-deployments.md`](web-surface-deployments.md).
- **trademark / fork / official service / provider compliance / release
  evidence boundary** -> [`../TRADEMARK.md`](../TRADEMARK.md),
  [`../ACCEPTABLE_USE.md`](../ACCEPTABLE_USE.md), and
  [`../PROVIDER_COMPLIANCE.md`](../PROVIDER_COMPLIANCE.md).

## How this map is maintained

- A document becomes a row here when it is a stable entrypoint for a user,
  contributor, or workflow consumer.
- A row's status must never claim more than the artifact delivers.
- `why` documents explain intent and design pressure; `verify` and `use`
  documents should state what is guaranteed, where to verify it, and the current
  maturity of that guarantee.
