---
status: accepted
period: ongoing
theme: buildchain-v4-declarative-release-tail
doc_type: decision
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-26
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-26
  invisible_context: unavailable
---

# ADR 0004: v4 release tails are sealed provider transactions

## Decision

Buildchain v4 release candidates carry a `kungfu.buildchain.v4-publication-qualification/v1` receipt. Build/Verify creates it from the candidate root, source root, typed artifact and manifest roots, floating-consumer policy digest, and a bounded freshness interval. The receipt root is written into every release-candidate Stage Capsule.

`release-candidate-promote` validates that evidence before publication. It does not check out the consumer repository and does not evaluate product-owned qualification, KFD, invariant, publication, activation, or evidence commands. The v4 path accepts no non-empty `command`, `cmd`, `script`, `shell`, or `run` input. The v3 path remains available with its existing inputs and behavior.

One Buildchain-owned provider transaction executes these ordered capabilities:

1. `artifact.publish` creates and reads back immutable GitHub Release assets.
2. `signed-channel.commit` commits the rooted channel document through the built-in GitHub document provider.
3. `release.activate` commits and reads back the rooted activation document.
4. `released-evidence.synthesize` writes receipt-only evidence from the sealed roots.

Buildchain aggregates the Release Passport before the first provider mutation. All four capabilities share one transaction root and use the existing Release Tail Provider Plane envelope, idempotency, retry, observation, and receipt contracts.

## Failure and resume semantics

The transaction state is checkpointed after every observation and effect. A retry reads the same state, verifies its declaration and plan roots, and starts at the first capability without a settled receipt. A provider result lost after mutation is recovered by readback. Conflicting or partially matching public state enters `repair-required` without another mutation.

The dogfood-only `provider-failure-after-capability` input interrupts after a durable capability checkpoint. The workflow immediately invokes the same built-in provider action against the same state path, proving local tail-only continuation and retaining the state, receipts, candidate evidence, and Release Passport as workflow artifacts.

## Consequences

- Consumers declare evidence and provider targets; they do not inject release-tail programs.
- Candidate, source, artifact, and policy mismatch, tampering, missing evidence, and stale evidence fail before provider mutation.
- Adding a new provider capability requires changing Buildchain's fixed capability registry and schema; arbitrary executable extension points are not a compatibility mechanism.
- v3 consumers are not forced onto the v4 evidence contract.
