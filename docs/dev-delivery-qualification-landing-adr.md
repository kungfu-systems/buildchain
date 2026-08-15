---
status: accepted
period: ongoing
theme: dev-delivery-qualification-landing-authority
doc_type: architecture-decision-record
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-15
---

# ADR: Qualification Leases and the exclusive Landing Warrant

## Decision

Buildchain has two explicit protected-dev authority modes:

1. `single-flight-warrant` is the default and continues to use the
   `kungfu-buildchain-dev-delivery-warrant-queue` v1 state and
   `buildchain dev warrant` commands unchanged.
2. `bounded-qualification-landing` is opt-in and uses the
   `kungfu-buildchain-dev-delivery-authority` v2 state. It may issue up to the
   configured number of Qualification Leases, but it may issue exactly one
   Landing Warrant.

The modes use different contracts, state refs, and CLI command families. There
is no implicit reinterpretation of a v1 Warrant. A consumer turns the new mode
on only by explicitly migrating the exact current v1 state and deploying the
v2 controller against the dedicated
`buildchain/dev-delivery-authority/<dev-line>` state ref.

Migration preserves the immutable v1 `stateRoot`, candidate identity, source
and proof roots, fencing token, generation, and lease times in a rooted
migration receipt. An active provisional Warrant becomes a
qualification-only lease and remains unable to admit `merge_group`; an active
qualified Warrant becomes the one exclusive Landing Warrant. The migration is
one-shot: a v2 state is never accepted as v1 input, and source/evidence bytes
are not regenerated. The legacy ref remains immutable rollback evidence.

## Authority invariants

A Qualification Lease carries:

- `authority = qualification-only`;
- `mergeGroupAdmission = false`;
- one exact candidate id, token, generation, issue time, and expiry; and
- a place in a list bounded by `policy.maxQualificationLeases`.

It authorizes expensive qualification work only. It cannot authorize GitHub
`merge_group`, cannot be upgraded in place to landing authority, and is removed
when qualification evidence is recorded. Each new candidate declares a sorted
set of rooted `qualificationDomains` and, for native delivery classes, the
exact `environmentRoot` established before native execution. Candidates with
disjoint sets may hold leases concurrently. An overlapping set is serialized;
an empty set is treated as unknown and therefore conflicts with every active
candidate. The scheduler returns a content-rooted reason for either refusal.

The native candidate phase runs in its own GitHub-hosted job without controller
or provider write credentials anywhere in its process ancestry. A dependent
credentialed finalizer must use live provider job readback to prove a different
job id and runner identity, ordered after native completion, and must verify the
content-addressed proof/state transfer, twice-read recursive regular-file-only
membership, canonical manifest and failure bytes, exact success or failure
manifest, live PR head, protected ref, and semantic native proof before it
rereads the exact live fence and records qualification or terminal settlement.
The failure chain binds its canonical evidence root to the transfer root,
provider boundary root, terminal native job, Warrant state root, and exact
fence. Candidate exit,
including exit zero from a shell whose descendant detached and unset runner
tracking, never grants provider mutation or Landing authority by itself.
Persistent self-hosted runners are unsupported because a job dependency does
not prove descendant cleanup or a fresh process authority domain.

Heartbeat authority is also process-separated. A credentialed GitHub-hosted
heartbeat job runs on a provider runner domain distinct from admission, native
execution, evidence sealing, and finalization. It advances only the admitted
fence with expected-old state roots, retains every transition receipt and
receipt root, and stops only after live provider readback shows native and seal
terminal. Every participating runner must be in the exact `GitHub Actions`
hosted group; a self-hosted group or label fails admission. The credentialless
native controller retains only the immutable admitted fence in memory and
never receives provider credentials or rewrites durable state. If renewal is
lost, the hosted heartbeat coordinator rereads and records the exact current
attempt but deliberately withholds GitHub's run-scoped cancellation call,
because a successor rerun can take over the same run coordinate after readback.
The stale fence stops further durable renewal, and terminal cleanup waits for
exact-attempt readback. The finalizer independently rereads those jobs and the durable
authority state, verifies the entire root chain, and requires the latest live
state root before any provider mutation.

The Landing Warrant carries:

- `authority = merge-group-admission`;
- `mergeGroupAdmission = true`;
- one exact qualified candidate id, token, generation, issue time, and expiry;
  and
- the only non-null `landingWarrant` slot in the durable state.

Only `admitDevDeliveryMergeGroup` and `buildchain dev authority
admit-merge-group` consume Landing authority. They bind the exact current state
root, candidate, protected base, source head, merge-group head, token, and
generation. Before persistence, the public Node API and CLI adapter accept only
the current run and run-attempt locator, then derive the workflow ref and SHA,
current Landing-authority job, hosted runner, source head, and merge-group head
from live GitHub readback. The raw verified-attempt transition is internal and
caller-supplied provider fields have no package export path. A Qualification
Lease fails closed at this boundary.

A new Landing Warrant is eligible only from
`authority = verified-native-qualification` with
`nativeProofAuthority = true` and the complete verified source proof, native
proof, execution binding, execution receipt, command, qualification contract,
and qualification receipt roots. `legacy-compatibility-only` evidence remains
readable and an already-active migrated historical Landing fence remains
exclusive for safe handoff, but compatibility evidence cannot mint a new
Landing Warrant.

The state normalizer rejects a lease beyond the configured bound, duplicate
Qualification Leases for one candidate, a candidate holding qualification and
Landing authority together, a Landing Warrant without its exact landing
candidate, and any state-root drift. Git expected-old, non-force ref advancement
continues to serialize durable mutations. These checks retain the existing
two-phase safety rule: source/native qualification is evidence, while the
exclusive final authority is candidate- and integration-specific.

## Bounded scheduler and recovery

Landing selection is FIFO among candidates that have completed qualification.
When a later candidate receives a Landing Warrant, each older nonterminal
candidate consumes one durable overtake from its
`policy.maxLandingOvertakes` budget. Once an older candidate reaches that
bound, later candidates cannot receive a Warrant. The older candidate receives
the next landing priority after qualification, or reaches a rooted terminal
failure after `policy.maxQualificationAttempts` heartbeat expiries. This makes
the bound independent of controller restart frequency or later arrival rate;
setting it to zero enforces strict FIFO landing priority.

Qualification Leases and Landing Warrants both support fenced heartbeats. An
expired qualification-only lease may be recovered because its stale token can
never admit `merge_group`. An expired Landing Warrant remains the exclusive
slot: elapsed time does not prove that an already-admitted provider attempt
stopped. Recovery therefore returns a rooted stop-required no-op until exact
provider stop or terminal evidence settles that same token and generation.
The cleanup verifier is independent of the caller and must return one rooted,
terminal readback bound to the exact repository, protected base and observed
base head, state root, candidate, pull request, source head, Landing token and
generation, provider run and job, and an observation time fresh for that
Warrant. A merged outcome additionally requires provider comparison evidence
that the admitted merge-group head is contained by the protected base. If the
PR later merges another head, the old attempt settles as dequeued rather than
receiving false merge evidence. Forged roots, wrong bindings, nonterminal
states, and stale observations fail closed. Only then does the deterministic
wake expose the next fair landing candidate. Completion, cancellation,
terminal failure, dequeue, and already-merged settlement emit the same wake
shape. Exact duplicate heartbeats, recovery, and terminal events are
state-root-preserving no-ops. Competing controllers still commit through one
expected-old, non-force ref update, so only one transition can become durable.

After merge-group admission, every Landing heartbeat carries the exact
persisted provider-attempt document as explicit input. Before renewal, the
GitHub adapter rereads that exact workflow run attempt and job and requires
both to remain active with the admitted repository, source head, merge-group
head, workflow, job, runner, and protected-base bindings. A controller that
has only the Landing fence cannot extend authority; the public renewal surface
does not accept a caller-supplied readback adapter. An exact-attempt loss or
terminal readback fails closed, and an already-expired Landing Warrant cannot
be revived by a later provider observation.

## Terminal settlement

Terminal provider evidence is authoritative cleanup input. A matching merged,
failed, dequeued, or cancelled candidate releases its Qualification Lease or
Landing Warrant in the same expected-old state transition, even when the lease
TTL has not expired. An active authority requires its exact token and
generation for that transition. Repeating the same outcome and evidence is a
root-preserving no-op; outcome or evidence drift fails closed. A terminal event
for a candidate that never entered the state is also an explicit no-op.

For an expired Landing Warrant, caller-supplied outcome and evidence are not
cleanup authority. The settlement uses the independently verified provider
readback outcome and evidence root after exact binding and freshness checks.
It reads `/actions/runs/{run_id}/attempts/{run_attempt}` rather than the mutable
run-scoped projection, and verifies the caller workflow through its persisted
workflow id and workflow endpoint rather than misclassifying it as a referenced
reusable workflow. The current pull-request head is observational during
terminal cleanup: synchronization may advance it, while the admitted source
head remains immutable in the candidate and provider-attempt evidence.
Before sealing, runtime validation enforces the published terminal schema:
completed run and job states, a non-empty run conclusion, an allowed terminal
job conclusion, and an `open` or `closed` pull-request state.
Terminal failure normalization preserves the native transfer root, finalizer
boundary root, native and seal job ids, admitted provider-attempt coordinates,
and the terminal readback root. Partial coordinate sets and round-trip drift
fail closed.

Qualification TTL recovery remains crash recovery, not the normal terminal
cleanup path. Landing crash recovery additionally requires provider stop or
terminal reconciliation before exclusive authority is released. Because the
GitHub cancellation API is run-scoped rather than attempt-scoped, expired
Landing cleanup never issues a run-level cancellation; it waits for terminal
readback of the exact admitted attempt and cannot cancel a later rerun.

Every later durable candidate for the same pull request must use
`chained-attempt-v2` and name the immediately preceding durable candidate. The
predecessor must already be terminal. The submission adapter derives this link
from the latest persisted state, while normalization rejects unchained,
skipped, nonterminal, or cross-PR predecessors.

## Public contract

- Machine schema:
  [`contracts/dev-delivery-authority-v2.schema.json`](../contracts/dev-delivery-authority-v2.schema.json),
  packaged as `dist/site/schemas/dev-delivery-authority-v2.schema.json`.
- Node API: `@kungfu-tech/buildchain/dev-delivery-authority` exports the v2
  state, migration, lease, heartbeat, recovery, Landing, admission,
  observation, settlement, terminal-readback creation, and expired-Landing
  readback verification functions. `@kungfu-tech/buildchain/dev-delivery-warrant`
  remains byte- and behavior-compatible for v1 consumers.
- CLI: `buildchain dev authority
<migrate|submit|lease-qualification|heartbeat-qualification|complete-qualification|lease-landing|heartbeat-landing|recover|admit-merge-group|settle|observe>`.
- Generated references: [`cli-reference.md`](cli-reference.md) and
  [`node-api-reference.md`](node-api-reference.md).

All mutations are plan-only unless `--execute` is supplied. Merge-group
admission is always a read-only authority check; it never mutates GitHub Merge
Queue itself.

## Consequences

Qualification throughput can increase without increasing the number of
candidates permitted to land. Consumers retain the byte- and behavior-compatible
single-flight default until they deliberately deploy the v2 mode. The tradeoff
is a second state contract and controller family; Buildchain keeps that
separation explicit so a rollout cannot silently weaken Warrant semantics.
