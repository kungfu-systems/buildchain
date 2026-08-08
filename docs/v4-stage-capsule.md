---
status: draft
period: ongoing
theme: buildchain-v4-stage-capsule
doc_type: contract-guide
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-09
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-09
  invisible_context: not asserted
---

# Buildchain v4 Stage Capsule

A Stage Capsule is the immutable, per-platform evidence contract for one build
stage. It does not store artifacts, plan resume, publish provider state, or move
production write authority. TypeScript v3 remains the sole writer; Rust is a
pure validation and root-projection implementation.

## Three separate roots

The contract deliberately keeps three facts separate:

1. `identityRoot` binds source, platform, stage, toolchain, runtime, policy,
   declared inputs, transformation, output manifest, qualification, and any
   explicitly declared rooted observations.
2. `capsuleRoot` binds that immutable identity and the retention promise.
3. `availabilityRoot` binds a caller-supplied observation of current
   availability, content, qualification, and rooted transport locators.

Changing platform, stage, policy, transformation, or a declared input changes
the identity root. Changing an observation time or transport locator changes
only the availability root. A provider run ID, provider artifact ID, runner
path, credential, ambient clock, raw network observation, mutable tag, or cache
hit is not a schema field and therefore cannot silently become identity.
Provider evidence participates only as an explicitly named observation root.

## Retention and reuse

A retention promise is not proof that bytes currently exist. Reuse is a pure
decision over an explicit evaluation clock and a current availability
observation. It is eligible only when the capsule, output-manifest, and
qualification roots all match, the observation is `available`, and the
retention promise has not expired. `missing`, `expired`, `corrupt`, and
`root-mismatch` always fail closed. Transport locators are rooted observations,
not artifact authority.

The sole schema authority is
[`v4-stage-capsule-v1.schema.json`](../contracts/v4-stage-capsule-v1.schema.json).
The shared fixture is consumed by both implementations. The next Wave 2 cards
may add checkpoints, resume planning, and reconciliation, but must not weaken
or duplicate this contract.

## Content-addressed reference store

The storage successor adds one closed output-manifest and store contract suite
without changing Capsule identity. Raw blob bytes use lowercase SHA-256 roots;
the canonical output manifest binds byte roots, sizes, and sorted names, and its
`manifestRoot` must equal the Capsule `outputManifestRoot`. The local reference
store writes immutable `blobs`, `capsules`, `manifests`, and `records` families
under exact roots. A fresh process can restore by `capsuleRoot`, then re-verifies
the Capsule, manifest, every byte root, retention state, availability, transport
observation, and qualification root before returning bytes.

Repeated put and restore are idempotent. A different physical store directory
does not change Capsule or manifest identity. `missing`, `expired`, `partial`,
`corrupt`, `quarantined`, and `root-mismatch` are deterministic fail-closed
classifications; there is no cache fallback. Retention promise, evaluated
retention state, current availability, rooted transport locator, qualification,
and operation receipt are different roots with caller-supplied clocks.

GitHub Artifact and S3-compatible adapters expose only `effect-disabled` and
`fixture-backed` modes in this slice. They accept rooted locators, never raw
credentials or signed URLs, and cannot perform a provider upload or restore.
The executable architecture ceiling is
[`v4-stage-capsule-store-contract.json`](../architecture/v4-stage-capsule-store-contract.json),
and the shared Rust/JavaScript fixture is
[`shared.json`](../contracts/fixtures/v4-stage-capsule-store-v1/shared.json).

Focused verification:

```sh
pnpm run check:v4-contracts
```
