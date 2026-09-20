---
status: draft
period: ongoing
theme: internal-release-candidate-evidence
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-20
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-20
  visible_context: Current consumer contract, workflow taxonomy, and retained candidate and recovery implementation contracts.
  invisible_context_boundary: No historical receipt, published payload, or external consumer is rewritten by this documentation change.
---

# Release Candidate Passport

Release candidates and their Passports are runtime-owned evidence. A consumer
maintains its schema-2 TOML and the generated normal/recovery workflow pair.
The normal pipeline binds and qualifies source, builds the declared products,
and manages publication. No consumer workflow downloads candidate artifacts,
constructs proofs, chooses a publication transaction, or prepares provider
requests. Start with the [Golden Path](getting-started.md).

This reference describes the retained candidate evidence mechanisms used by
internal promotion and historical receipt readers. It does not add another
consumer API. The internal [promotion request](release-promotion-request.md)
schemas and component workflows must not be copied into consumer wiring.

## Candidate and publication evidence

`release-candidate-passport.json` records evidence collected before promotion:
source identity, channel, runtime, workflow execution and verified platform
artifacts. `buildchain.release.json` is the durable published Release Passport.
These records have different purposes and retain their established schema and
hash identities.

The `kungfu-buildchain-release-candidate-passport` contract includes:

- repository and PR context;
- target channel/ref and version, or a non-publishing source candidate label;
- source head, merge ref and Git tree identities;
- Buildchain runtime and workflow entry identities;
- exact workflow run and attempt;
- platform matrix, artifact summaries and aggregate build-summary hash.

Internal admission checks the repository, channel, source, platform matrix,
summary and payload inventory before version, transaction, tag or branch
mutation. Accepted source equivalence must retain the complete proof; matching
a Git tree alone does not admit a candidate. Artifact names, source selectors
and roots are runtime transport fields, not TOML extensions.

The candidate resolver remains bound to the exact source and matching trusted
PR execution. A partial green status, sibling run, incomplete upload or timeout
cannot replace successful complete candidate evidence.

## Initiative-family release evidence

The retained adapter can normalize
`kungfu-buildchain-initiative-family-release-evidence/v1` into the candidate
hash and publication authority. It can identify the family root, Initiative,
Assignment and previous family root. Required evidence must match these exact
identities before mutation.

Kungfu owns native Family State and Work Control. Buildchain proves only that
its candidate consumed the bound evidence exactly. Consumers do not add a
family-evidence JSON transport to the shared workflow callers.

## Resume from an existing candidate run

For current consumers, dispatch the generated `buildchain-recover.yml` with
an exact `attempt`. An optional `runtime-ref` can identify repaired tooling.
`public-ops-recover.yml` resolves the retained attempt and determines what can
be resumed. Consumers do not supply candidate run IDs, replacement source,
expected trees, roots, discussion IDs, transaction overrides or an extra
recovery workflow.

Internal recovery retains the original source and material identities. The
retained candidate recovery mechanism validates trusted repository/PR/run
provenance, workflow identity, target ancestry, candidate and summary roots,
controller receipts, platform inventory, archive sizes/digests, manifests and
product payload bytes. Its existing receipt schema remains
`kungfu-buildchain-release-candidate-recovery/v1`.

Reusing a qualified sealed candidate preserves its product bytes, including the
original npm tarball. A newer repair runtime is recorded as tooling; it cannot
change the original payload root or substitute new product source. Recovery
skips only stages justified by the retained attempt and evidence. It never
turns missing or conflicting material into a hidden fresh build.

An expected durable transaction must already exist with the same identity.
When internal admission permits creating missing transaction state, the state
is sealed from the verified original material. Existing phases use the normal
idempotent state machine. Missing publication work may continue; conflicting
public digests remain a repair failure.

## Completed publication and immutable history

Completed-publication recovery first verifies the retained transaction and
provider state. Same-name published evidence and payloads retain their original
bytes. Fresh recovery evidence belongs to the new recovery observation; it does
not silently replace the completed publication's evidence.

The retained recovery implementation may restore missing product bytes from
the verified sealed bundle. Restoring an absent Release Passport requires its
complete locally verified evidence closure, a check for undeclared remote
assets, and byte comparison of existing same-name assets before mutation.
Conflicting names or digests fail closed.

A protected target may advance after publication. Recovery must still bind the
original transaction and prove permitted ancestry from that immutable source;
it records both the transaction source and observed target. It cannot retarget
an old transaction to a newer candidate.

A new release uses a new legal candidate/version. Abandoning a failed alpha
leaves its historical attempts, source locks, receipts, tags and any published
bytes intact. See [Publish Transaction](publish-transaction.md).

## Product differences

npm packages, binary assets and Paper PDFs use the same generated callers.
Their install/build/verify commands, platform declarations, artifact paths and
publication targets belong in TOML. There is no separate consumer binary
workflow, Paper publication wrapper, credential-bearing publish command,
custom qualification handoff, or public request-JSON wrapper.

Runtime components retain separate credential and permission boundaries for
source qualification, sealed evidence, provider publication and readback. The
smaller consumer API does not collapse those internal boundaries. Legacy
receipt fields remain readable where required; they do not become accepted
fields in the closed schema-2 consumer plan.
