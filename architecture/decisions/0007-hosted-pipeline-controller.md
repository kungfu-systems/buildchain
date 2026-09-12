---
status: draft
period: ongoing
theme: minimal-consumer-pipeline
doc_type: architecture-decision-record
source_level: local-files
confidence: medium
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-13
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-13
  visible_context: Third-child Assignment, existing Warrant domain, GitHub adapter source and local fault tests.
  invisible_context_boundary: Hosted integration and published consumer qualification have not yet completed.
---

# ADR 0007: Hosted pipeline history and provider effects

The normal pipeline admits repository-owned channel PRs using policy read from
the protected base. PR TOML supplies the product commands to the credentialless
build job. It cannot grant itself a channel route or lower protected review
requirements. Source commit, tree, configuration blob and bytes are verified;
the PR and protected branch are read again before returning an observation.
Webhook fields select readback work and do not authorize effects. Terminal-only
events cannot start product execution. Internal journal ref pushes are ignored.

The hosted writer refines ADR 0006's storage boundary. GitHub Discussion appends
do not provide atomic expected-head updates, and workflow concurrency alone
does not fence an in-flight append from an interrupted writer. The pipeline
therefore admits the existing immutable attempt records through one Git-ref
journal. Each update has exactly one observed parent and uses a non-force
fast-forward update; competing children cannot both advance that parent.
The writer reads committed bytes back, including after a lost HTTP response.
Discussion is a readable projection of the admitted records. It is not a
second authority, and the earlier Discussion reader and histories remain
available. The hosted path does not claim that the library's injected
Discussion lock provides cross-process exclusion.

An attempt's source generation, phase order and terminal history retain their
ADR 0006 identities. Recovery opens a successor after terminal reconciliation;
it does not inherit successful phases or rewrite prior results. Duplicate
event keys must retain the same meaning. Product commands execute through the
existing consumer-shell session with a credential allowlist and private file
command channels. A subprocess result is an observation; independent hosted
completion, artifact and source qualification remain necessary for reuse.

Cancellation retains its exact provider readback material and commits a pending
attempt record before invoking the existing Warrant domain transaction. Queued
cleanup selects its own candidate even when another candidate is active.
Active cleanup requires the admitted run attempt and separate native/seal jobs
to be terminal in fresh provider readbacks. Lease expiry alone cannot release
the Warrant. The credentialed independent heartbeat and finalizer check attempt
stop requests. The native job retains its credentialless boundary and must
finish or reach its hosted timeout before ownership can transfer; the controller
does not cancel an entire GitHub run that could have acquired a newer run
attempt. Domain expected-old roots and active fences are derived
internally from fresh queue state.

The public normal entry accepts only `config-path`. Its jobs separate runtime
selection, provider control, credentialless product commands, independent build
readback and guarded native delivery. The internal delivery component transports
the retained request; admission, qualification and landing reject changed request
fields and a different provider run attempt. Candidate source roots include the
business attempt, so a terminal candidate cannot block a later attempt of the
same source. Scheduling uses an expected journal head and retains live executions
when jobs have not yet appeared in the provider inventory.

Attempt wake selects its runtime lock from the recorded source commit. A changed
source generation opens a successor only after old-candidate cleanup, then wakes
again if its source requires another runtime selection. Branch notifications wake
existing intents without inventing historical releases. Every declared product
platform runs on the standard hosted matrix; the independent native command uses
one declared platform, while exact merge-group verification repeats the complete
product matrix. No additional native platform coverage is inferred from that
single native execution.

The protected base supplies review policy. Fresh GitHub readback must enforce
the declared independent approval count, Code Owners, merge queue and required
checks. PR approvals bind the exact source commit. Release-channel PRs use that
protected queue; their merged source enters the separate publication stage.
Development settlement requires the exact source PR, protected ancestry,
successful exact merge-group execution and retained integration proof before
the Warrant state changes. Terminal notifications replay retained receipts if a
successor wake was interrupted.

If a cancellation write succeeds but its response is lost, the retained pending
material must match the candidate's terminal evidence before its attempt
projection is completed. An interrupted successor dispatch can be retried from
the same terminal evidence without rewriting history. Receipt material uses
the existing immutable recovery archive and verifies digest and size on read.
Neither the archive nor a planned operation grants merge or publication rights.

Local tests currently cover the journal's competing writers and response loss,
corrupt bytes, stale events and source drift, protected-policy selection,
credentialless subprocess exit failures, native stop fencing, exact provider
worker readback, queued versus active cleanup, lost settlement responses and
interrupted successor wake. Tests also exercise the public controller's build
and delivery handoff, duplicate-event retention, same-source successor identity,
runtime source selection, exact merged settlement response loss and readable
Discussion projection. Public workflow wiring is implemented; hosted execution
and published qualification have not been claimed from these local tests. Product release
drivers, the public recovery interface, self publication and final minimal
consumer qualification remain the responsibilities of subsequent children.
