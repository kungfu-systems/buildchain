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

## Map

| Your question | Document | Plane | Status |
| --- | --- | --- | --- |
| What is Buildchain, in one idea? | [`../README.md`](../README.md) | - | stable |
| How do agents and contributors enter this repo? | [`../AGENTS.md`](../AGENTS.md) + [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | use | stable |
| How do I install or run the `buildchain` CLI? | [`cli.md`](cli.md) | use | stable |
| How do I initialize a new repository? | [`cli.md`](cli.md) + [`lifecycle-protocol.md`](lifecycle-protocol.md) | use | stable |
| Why does Buildchain use branch-driven release governance? | [`release-governance.md`](release-governance.md) | why | stable |
| When must a change open a minor or major (and when must it not)? | [`versioning.md`](versioning.md) (rule: KFD-1) | verify | stable |
| What exact branch/tag state machine runs on alpha, release, and major gate? | [`release-flow.md`](release-flow.md) | verify | stable |
| What did Buildchain migrate or retire from old action repositories? | [`migration-inventory.md`](migration-inventory.md) | verify | stable |
| What is the active action and workflow source of truth? | [`ownership.md`](ownership.md) | verify | stable |
| How do I declare version files and custom lifecycle commands? | [`lifecycle-protocol.md`](lifecycle-protocol.md) | use | stable |
| How does publish evidence, recovery, and finalization work? | [`publish-transaction.md`](publish-transaction.md) | verify | stable |
| How do I call the reusable build workflow? | [`reusable-build-surface.md`](reusable-build-surface.md) | use | stable |
| How do I deploy a site/app preview, staging, or production surface? | [`web-surface-deployments.md`](web-surface-deployments.md) | use | stable |
| How do I use the active actions directly? | [`../actions/validate-config/README.md`](../actions/validate-config/README.md), [`../actions/run-lifecycle/README.md`](../actions/run-lifecycle/README.md), [`../actions/promote-buildchain-ref/README.md`](../actions/promote-buildchain-ref/README.md) | use | stable |
| What do the fixture repositories demonstrate? | [`../fixtures/libnode-shaped/README.md`](../fixtures/libnode-shaped/README.md), [`../fixtures/publish-transaction-shaped/README.md`](../fixtures/publish-transaction-shaped/README.md), [`../fixtures/web-surface-shaped/README.md`](../fixtures/web-surface-shaped/README.md) | verify | stable |
| What license and contribution terms apply? | [`../LICENSE`](../LICENSE) + [`../LICENSE-POLICY.md`](../LICENSE-POLICY.md) | use | stable |
| How do I report a vulnerability? | [`../SECURITY.md`](../SECURITY.md) | use | stable |

## Also asking about

- **ABV / old workflows / old action repositories** -> [`release-governance.md`](release-governance.md)
  and [`migration-inventory.md`](migration-inventory.md).
- **v2 / v2.0 / v2.0-alpha / exact tags / floating tags** ->
  [`release-governance.md`](release-governance.md) and
  [`release-flow.md`](release-flow.md).
- **dry-run / what would happen if this channel PR merges** -> [`cli.md`](cli.md)
  and [`release-flow.md`](release-flow.md).
- **pnpm / npm / yarn / package-manager adapters** ->
  [`lifecycle-protocol.md`](lifecycle-protocol.md).
- **pip / Conan / CMake / custom commands** -> [`lifecycle-protocol.md`](lifecycle-protocol.md)
  and [`reusable-build-surface.md`](reusable-build-surface.md).
- **libnode / native artifacts / self-hosted runner matrix** ->
  [`reusable-build-surface.md`](reusable-build-surface.md) and
  [`../fixtures/libnode-shaped/README.md`](../fixtures/libnode-shaped/README.md).
- **Trusted Publishing / npm / publish evidence / recovery** ->
  [`cli.md`](cli.md) and [`publish-transaction.md`](publish-transaction.md).
- **sites / web previews / staging / production gates** ->
  [`web-surface-deployments.md`](web-surface-deployments.md).

## How this map is maintained

- A document becomes a row here when it is a stable entrypoint for a user,
  contributor, or workflow consumer.
- A row's status must never claim more than the artifact delivers.
- `why` documents explain intent and design pressure; `verify` and `use`
  documents should state what is guaranteed, where to verify it, and the current
  maturity of that guarantee.
