---
status: active
period: ongoing
theme: buildchain-release-promotion-action
doc_type: technical-reference
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
  visible_context: Current promotion adapters, public workflow and request contract.
  invisible_context_boundary: No external publication or consumer qualification is claimed.
---

# Release promotion adapter

The consumer API is
[public-release-promote.yml](../../../../.github/workflows/public-release-promote.yml).
It admits one closed JSON request, qualifies exact source and runtime identities,
applies the admitted publication plan, and settles provider evidence in separate
permission boundaries. See the [request contract](../../../../docs/release-promotion-request.md).

This Node action binds GitHub Actions inputs and outputs to the promotion
coordinator. Its implementation lives in
[packages/core/release/promote-ref](../../../../packages/core/release/promote-ref).
The entrypoint contains no business logic; `inputs.js`, `request.js`, `source-lock.js`,
`outputs.js` and the internal capability modules own their respective operations.

The canonical channel graph is
`dev/vX/vX.Y -> alpha/vX/vX.Y -> release/vX/vX.Y`, with
`publish-gate/major` as the explicit major transition. An exact release tag,
floating channel and version-state commit are separate evidence coordinates.
Retired branch aliases and publisher-selection inputs are not accepted.

Ordinary GitHub Release publication uses the declarative provider adapter.
Complete-transaction recovery first proves the retained transaction and exact
provider assets. A missing asset never permits replacement of an existing asset
with a different digest. The full existing asset set is checked before any upload.

Version-state discovery reads declared TOML settings and package-manager workspace
metadata, including nested action packages. Anchored/manual products retain their
explicit upstream anchor; semver/auto products prepare the next development version
through the governed next-development transition.

Dry-run reports the exact intended effects and performs bounded read-only provider
lookups. It does not authorize publication. Live publication requires the admitted
source lock, runtime identity, candidate evidence, provider policy and protected
channel transaction. See [release governance](../../../../docs/release-governance.md)
and [provider-plane settlement](../../../../docs/release-tail-provider-plane.md).

Generated JavaScript and the Rust domain WASM are committed under `dist` and must
match the source. Run `pnpm run build` and `pnpm run check` from the repository root.
The 4.1 development restructuring itself does not publish an alpha or move a floating tag.

## Admitted promotion inputs

The workflow's apply node supplies these source-lock and candidate inputs to the
adapter. This fragment documents the internal action ports; consumer callers use
the public request contract linked above.

```yaml
with:
  target-ref: release/v22/v22.22
  require-publish-source-lock: "true"
  publish-source-ref: ${{ needs.build.outputs.publish-source-ref }}
  publish-source-sha: ${{ needs.build.outputs.publish-source-sha }}
  publish-source-locked: ${{ needs.build.outputs.publish-source-locked }}
  promote-only-release-candidate: "true"
  release-candidate-family-evidence-required: "true"
  publish-rematerialize-on-resume: true
```

`target-ref` remains the channel promotion target. Direct `alpha/*` or `release/*` channel refs
are not publish source locks. A mismatched source SHA fails before any promotion or publish side effects begin.
The exact candidate Passport, family evidence and reconciliation workspace are
validated before provider effects; rematerialization requires the sealed recovery contract.

Passport evidence ports bind product-owned evidence to the resulting release:
`release-passport-kfd-1-witness-jsons`, `release-passport-kfd-2-claim-jsons`,
`release-passport-kfd-3-prebuild-witness-jsons`,
`release-passport-kfd-adopter-manifest-json`,
`release-passport-kfd-support-matrix-json`, and
`release-passport-kfd-product-gate-jsons` carry the corresponding KFD evidence.
`release-passport-evidence-jsons` carries additional evidence documents;
`release-passport-invariant-passport-command` and
`release-passport-attachment-command` identify the declared product-owned evidence
operations. These ports do not replace consumer qualification or provider readback.
