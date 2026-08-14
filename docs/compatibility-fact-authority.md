---
status: active
period: ongoing
theme: buildchain-compatibility-fact-authority
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-15
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-15
  invisible_context: not asserted
---

# Compatibility Fact Authority

Buildchain contract compatibility is authorized by immutable, directional
Facts. Digest lists and the older compatibility-proof objects remain published
for existing consumers, but they are deterministic projections and cannot
authorize a contract transition by themselves.

## Authority chain

The package-owned source is
`packages/core/buildchain-compatibility-facts.json`. The runtime validates every
entry and projects it into:

1. a `kungfu.fact.temporal-predicate/v1` declaration scoped to
   `accept-contract-lock`;
2. one `kungfu.fact.temporal-relation/v1` record per accepted transition;
3. a bounded `kungfu.fact.temporal-bundle/v1` with an exact current Cut;
4. a `kungfu.buildchain.compatibility-fact-registry/v1` identity containing all
   Fact, lifecycle, legacy-proof, Cut, and temporal-bundle roots;
5. the legacy proof registry and per-surface digest/proof arrays as verified
   projections.

The temporal records use `kungfu.fact-root.canonical/v2` (KFR2), so Kungfu can
reproduce their roots without adopting Buildchain's JavaScript hashing helper.
The historical proof roots and proof registry root do not change during this
cutover.

## Decision semantics

- Direction is always source to target. Reversing a relation rejects with
  `direction-mismatch`.
- The operation is exactly `accept-contract-lock`; another operation rejects
  with `unscoped-compatibility`.
- The normal lock evaluator resolves one direct Fact. It never searches for or
  infers a transitive path.
- Composition is available only when the caller supplies an ordered path and a
  positive `maxDepth` through `createBuildchainCompatibilityPathQuery()` and
  `verifyBuildchainCompatibilityPath()`.
- Every positive or negative decision produces a rooted
  `kungfu.fact.temporal-path-receipt/v1`.
- Supersession and revocation are append-only temporal records. They affect a
  later Cut but do not change the result replayed at an earlier pinned Cut.
- Missing Facts, ambiguous direct edges, orphan roots, drifted projections,
  cycles, inactive relations, implicit transitivity, superseded relations, and
  revoked relations fail closed.

## Contract world and lock fields

`dist/site/buildchain-contract.json` publishes:

- `compatibilityFacts`;
- `compatibilityFactRegistryRoot`;
- `compatibilityFactCutRoot`;
- the retained `compatibilityProofs` and `compatibilityProofRegistryRoot`;
- per-surface `compatibleBreakingDigests`, `compatibilityProofRoots`, and
  `compatibilityFactRoots` projections.

Consumer lock files copy the registry and Cut roots. A current contract world
without compatibility Facts is invalid. An older lock without Fact fields is
still retained as historical input, but it does not turn a Fact-less current
runtime into an accepted legacy world.

The v2 Buildchain verification receipt binds the used proof roots, Fact roots,
and temporal path receipt roots. The verifier continues to recognize an exact
v1 receipt so already-retained evidence is not rewritten.

## Adding a compatibility decision

Append a new fact source entry; do not edit an existing entry or add a digest
directly to a surface. The entry must bind the source and target breaking
digests, surface and operation scope, protected-merge evidence, protected
authority, and effective Git Cut. Then regenerate the site/reference artifacts
and run the complete check.

When replacing or withdrawing a relation, append a temporal supersession or
revocation record. Never mutate the old relation. Qualification must include a
test that replays both the prior Cut and the current Cut.

The Fact registry does not grant release, publication, merge, or workflow
authority. It answers only the scoped contract-lock compatibility question.
