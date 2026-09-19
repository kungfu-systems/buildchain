---
status: draft
period: ongoing
theme: minimal-consumer-contract
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
  visible_context: Immutable seven-child Assignment and current Buildchain source and tests.
  invisible_context_boundary: The new pipeline and recovery entries are not yet implemented or published.
---

# ADR 0005: The consumer owns product intent, Buildchain owns execution

## Contract and rollout boundary

Schema 2 is a closed TOML contract compiled by
`packages/core/consumer/contract/plan.js`. The compiler receives bytes and has no
filesystem, process or provider interface. It never runs a configured command.
Unknown fields fail, including arbitrary request envelopes and publication
commands. Build and verification commands remain product code, executed later
in an isolated job with no delivery, signing or publication credentials.

Consumers maintain `.buildchain/buildchain.toml` and two generated callers.
The normal entry receives the platform event and an optional `config-path`.
Recovery receives one exact `attempt` and an optional transient `runtime-ref`.
`entries.js` owns both interfaces and product-independent caller bytes.
No consumer assembles candidate, Warrant, fence, proof, nonce, run, transaction
or Discussion selectors. An attempt is a Buildchain business identity, not a
GitHub run ID, run-attempt number or Discussion number.

This first slice defines and tests that contract. Its generated examples are
qualification fixtures, not a claim that the new public entries already exist.
The normal controller is delivered in child 3; recovery in child 5; Buildchain
self migration and published alpha/stable qualification in child 6; old public
surface retirement in child 7. Schema 1 is not translated by the new compiler.
Existing consumers remain on the old implementation until the reviewed
migration replaces their configuration and entry together. There is no final
compatibility wrapper, hidden script, or product-specific entry.

## Product plan

Each product declares an ID, type (`npm`, `binary`, `paper`), exact supported
platforms, optional install commands, build and verify commands, output
artifacts and publication targets. Artifact IDs are unique and targets must
cover exactly the declared output set. npm publishing is a typed npm target;
archive and PDF publication use GitHub Release. Provider credentials are
one-time setup, never TOML values or command arguments.

Version files, strategy, legal channel PR routes and required independent
review/merge queue are explicit. Existing dependency locks remain ordinary
product source and are retained by initialization/migration. The internal
executor must install dependencies under their lock and current supply-chain
policy. TOML cannot weaken branch protection or substitute a local check for
independent source, receipt or provider readback.

## Events, identities and authority

The normal event vocabulary covers PR lifecycle, review, merge group and push.
Buildchain-owned `repository_dispatch` wake events are internal notifications;
their payload is untrusted until the controller verifies its retained attempt
and provider evidence. There is no manual JSON dispatch interface. Wake events
never create authorization and duplicate or old events cannot authorize a new
source. The controller owns deduplication, writer fencing and terminal wakeup.
Consumer YAML contains no event routing logic or internal workflow names.

The trusted `pull_request_target: closed` notification also covers closing a
conflicted PR, for which GitHub does not run `pull_request`. This is a
cancellation/settlement observation only and must never execute PR code.
Merge-group removal is reconciled from PR dequeue and live queue readback;
`merge_group` subscribes only to GitHub's supported `checks_requested` type.
See the [GitHub event contract](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

The platform-provided event is only an observation. Admission resolves the
repository, PR head/base and tree through trusted provider readback. Config
bytes bind to the exact Git blob, config path and source commit. The compiler
returns data; its digest is not merge or publication authority. PR-controlled
config and artifacts are not consumed in a job holding privileged credentials.
Caller permission declarations are upper bounds; internal jobs must narrow
them and keep untrusted builds separate from qualification and provider writes.
Fork events must never receive repository write credentials or inherited secrets.

The generated contract lock binds the contract version, entry SHA, selected
runtime SHA and configuration byte digest. It does not bind the consuming Git
commit: committing a tracked lock must not invalidate that same lock. Exact
source commit/tree identity is bound separately for each execution attempt.
Entry and runtime may differ. A normal run
uses its admitted lock; recovery may select a repaired runtime once through
the central entry. Downstream nodes do not compare Buildchain SHAs. A changed
contract requires an explicit reviewed config/lock upgrade; schema mismatch
fails rather than silently interpreting old data. An entry bug requires an
upgraded published entry and a full new execution.

## Evidence and enforcement

`generate-minimal-consumer-contract.mjs --check` verifies all three generated
examples and the complete migration inventory of current public/self inputs,
caller edges, template/fixture configuration and consumer scripts. Inventory
destinations distinguish provider setup, plan-derived internal arguments and
attempt-owned material/authority. They are migration obligations, not deleted
functionality or already-migrated state.

`inspectConsumerContract` requires the exact two generated workflows and scans
the supplied complete consumer tree for known internal orchestration. The
caller comparison closes YAML wiring; the TOML validator closes configuration
keys. Source scanning detects known bypasses but is not a proof of arbitrary
program behavior. Credential isolation and provider authorization remain
mandatory even when this static gate passes. Child 7 must validate the final
reachable source/generator closure and adversarial cases after migration.

Tests compile all three plans, reject invalid input/state/route/target/review
changes, verify exact Git blob binding with different entry/runtime commits,
and build actual package contents, a native archive and a valid PDF in isolated
directories. These are local contract/product tests; they do not constitute
hosted execution, release, provider authorization or recovery qualification.
