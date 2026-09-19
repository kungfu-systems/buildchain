---
status: draft
period: ongoing
theme: minimal-consumer-attempt-journal
doc_type: architecture-decision-record
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-12
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-12
  visible_context: Captured second-child Assignment, Discussion implementation and local fault tests.
  invisible_context_boundary: Hosted pipeline integration and published consumer qualification belong to later slices.
---

# ADR 0006: One PR intent, immutable generations and recoverable attempts

The internal `workflow/attempt` modules extend the existing Release Discussion
journal. PR number, repository identity and target branch identify the intent.
Exact source commit, tree, TOML blob/digest/path and observed protected base
identify a generation. A request key plus generation and predecessor identifies
a business attempt. Provider run, run-attempt and job identify each writer;
several provider runs may contribute to one business attempt.

The admitted ordered phase set covers admission, build, review, Warrant, merge,
publication, distribution and next-development. A channel-specific plan may
omit inapplicable phases. Every phase requires successful predecessors. Waiting,
failure, cancellation and supersession retain a reason. Terminal phase results
cannot be rewritten: recovery opens a successor with no inherited success.
Published historical results remain readable even when a new source or base
requires a new generation. Projection completion does not grant delivery,
publication or material-reuse authority.

Each event includes its content digest, previous event digest, exact attempt
and generation, sequence, bounded idempotency key, writer and runtime reader
identity. Replay rejects gaps, forks, conflicting duplicate keys, undeclared
or out-of-order phases, missing predecessors, identity drift and history bounds.
Identical repeated records have one meaning. A reader may receive pages out of
order; sequence and content links reconstruct the original history.

`businessAttemptStore` uses the existing provider-authenticated Discussion
transport, immutable attempt roots and reply pagination. Only the expected
writer's unedited records contribute. Initialization verifies the repository
node identity. Unknown mutation responses are reconciled by reading back the
same immutable identity before retry. No attempt state is written into the
consumer source tree and no independent index or second authoritative store
is introduced.

The store has no default lock. Its internal `exclusive.run` adapter must own
the repository/intent writer scope across hosted processes and retain that
exclusion through the final provider mutation. `assertOwner` is rechecked at
scope admission and immediately before create/append. Expected-head comparison
and current-attempt checks fence stale results. The adapter must not transfer
ownership while an in-flight provider mutation can still commit: a local mutex
or a check followed by an unfenced lease expiry is insufficient. Child 3 owns
the hosted controller adapter; this library slice does not claim hosted writer
exclusion from the injected test fixture. The provider remains the persistence
authority; a fork makes the reader fail closed rather than selecting a winner.

Material references distinguish artifacts, checkpoints, receipts, Passports
and provider readbacks. Each binds byte count, digest, producing attempt,
generation and a permanent consumer-repository URL. Signed URLs and credentials
are rejected. A reused material ID cannot acquire different bytes. The internal
material verifier checks retrieved bytes; storing a reference alone does not
prove retrieval, provider authorization or qualification for another attempt.
Existing receipt, Passport and provider journal rules continue to own those
facts. Recovery must qualify retained material under the successor's current
rules before emitting fresh evidence.

The retained `dist/readers/business-attempt.cjs` is self-contained and accepts
captured authenticated JSON on stdin. Its CLI outputs status, reason, attempt,
generation, missing phases and the one recovery selector. The bundle is
reproducibility-checked alongside the historical release reader and tested in
a fresh process with filesystem access restricted to the bundle. It has no
provider write or effect-recovery entry. A runtime's recorded reader digest
must be verified by the existing archive-loading boundary before execution;
the pure reader does not authenticate caller-supplied records itself.

The fault tests cover identity drift, incomplete and corrupted chains, duplicate
and out-of-order delivery, concurrent/stale writers, cancellation/failure state,
response loss after provider commit, restart, untrusted/edited records, material
integrity and published-history preservation. Hosted control, user-facing
attempt selection, actual provider recovery and self publication remain the
explicit responsibilities of children 3 through 7. This slice adds no public
workflow or consumer input.
