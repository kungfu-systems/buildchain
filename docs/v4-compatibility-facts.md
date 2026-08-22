---
status: active
period: ongoing
theme: buildchain-v4-compatibility-facts
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-16
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-16
  invisible_context: not asserted
---

# Buildchain v4 compatibility Facts

Buildchain v4 authorizes contract compatibility with immutable, directional
Facts. `compatibleBreakingDigests` and the v1 proof objects remain public for
older consumers, but they are deterministic projections. Neither can authorize
a transition without the current Fact registry, its exact Project Cut, and a
verified path receipt.

## Authority chain

The package source is
`packages/core/buildchain-compatibility-facts.json`, retained from v3 exact head
`6b96bdad8d9f8ccf9275f27d9370a226a9c78465`. Each declaration becomes a KFR2
predicate and relation, then enters an append-only temporal bundle. The
registry identity binds all Fact, proof, Cut, supersession, revocation, and
bundle roots.

V4 projects a legacy digest only when a verified Fact targets the exact current
surface kind, ID, and breaking digest. The old proof's v2/v3 `majorLines` field
is historical projection metadata; it does not narrow or enlarge the
digest-and-Cut-bound Fact. A target digest that has changed since v3 receives no
projection.

## Decision semantics

- Direction is always source to target. Reverse use rejects.
- The only operation is `accept-contract-lock`.
- Evaluation selects one direct Fact. It never searches for a path or infers
  symmetry or transitivity.
- Composition requires an ordered caller-supplied path and positive bounded
  depth.
- Supersession and revocation append lifecycle records. Old Cuts replay old
  truth; later Cuts deterministically reject superseded or revoked relations.
- A revocation is the safety-equivalent expiry boundary: compatibility has no
  wall-clock-only truth outside a rooted Cut.
- Missing, ambiguous, not-yet-valid, revoked, superseded, wrong-direction,
  wrong-Cut, disconnected, cyclic, inactive, or corrupted inputs produce a
  rooted rejected receipt.

Rust and TypeScript implement the same KFR2 closed-field encoding and emit
byte-identical JSON for the shared fixture in
`contracts/fixtures/v4-compatibility-facts-v1/shared.json`.

## CLI and Node API

Project and verify the built-in registry:

```sh
npx @kungfu-tech/buildchain facts compatibility project --json
npx @kungfu-tech/buildchain facts compatibility verify --json
```

Create a direct query template for one current Fact, then verify it:

```sh
npx @kungfu-tech/buildchain facts compatibility query-template \
  --fact-root sha256:... --json
npx @kungfu-tech/buildchain facts compatibility query \
  --query query.json --registry registry.json --json
```

The `@kungfu-tech/buildchain/compatibility-fact-authority` export provides the
same constructors, verifiers, resolver, and Release Passport evidence helper.
Compatibility evidence explicitly sets `grantsReleaseAuthority: false`; it can
be attached through the existing release-evidence route but cannot publish,
merge, sign, or release anything.

## Updating the registry

Append a new source Fact or lifecycle record. Never rewrite an existing Fact,
directly edit a surface digest allowlist, or convert a caller claim into
authority. Regenerate references and site facts, then run the shared parity
fixture and the complete repository check.
