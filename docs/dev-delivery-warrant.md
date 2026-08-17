---
status: accepted
period: ongoing
theme: dev-delivery-warrant
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-17
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-11
  invisible_context: not asserted
---

# Dev Delivery Warrant Queue

Buildchain's Dev Delivery Warrant Queue gives a qualified slow pull request a
durable, non-preemptive delivery turn without replacing GitHub Merge Queue as
the final protected-ref authority.

The queue is stored on a dedicated Git ref below
`buildchain/dev-delivery-warrant/`. Every update creates a child Git commit and
advances the ref without force. The transition receipt binds the expected old
state root; a competing controller receives a visible non-fast-forward failure
instead of a second authority claim.

## Contract

A submission binds the repository, protected dev line, pull request, semantic
source identity, exact source head, native Assignment and Initiative roots,
source patch or tree intent, reusable Source Qualification Proof, plan,
affected closure, dependencies, toolchain, delivery class, priority, attempts,
and retained enqueue time.

Selection is deterministic FIFO plus aging with bounded priority. Priority may
reorder queued work, but it cannot preempt the active Warrant. Exactly one
candidate receives a `provisional` leased Warrant containing a fencing token,
lease generation, expected-old state root, expiry, and the complete exact
source binding. It reserves the next protected-dev landing before expensive
native shards start, but it is not GitHub Merge Queue admission authority.
Heartbeat extends only that generation. Native proof success atomically
upgrades the same token and generation to `qualified`; only then may enqueue
begin. Expiry fences further mutations by the old token, but it does not prove
that the old native process stopped. The active Warrant therefore remains in
place until bounded termination is proven by rooted terminal evidence. Only
that exact fenced settlement may clear the holder and permit successor
selection.

A terminal event may cancel a candidate before selection without minting a
Warrant. This transition is limited to an exact non-active queued candidate and
binds its candidate root, pull request, recorded source head, event-observed
source head, terminal event action, evidence root, and expected-old queue root.
An active candidate still requires its current fencing token and lease
generation. Exact duplicate cancellation evidence is a visible no-op; identity,
state, event, or evidence drift fails closed.

The reusable terminal controller classifies authoritative completion,
cancellation, supersession, native failure, and transient dequeue separately.
`dequeued` alone never clears an active Warrant: a fresh holder continues with
the same generation and token, while an expired holder waits for proof that its
fenced worker stopped. Queued work may still settle as dequeued because it never
started native execution. The controller uses one `settle` operation for active,
queued, already-terminal, and never-admitted pull requests. An active Warrant
still requires its exact fence and evidence. A matching queued cancellation is
persisted normally. A duplicate terminal event or a pull request that never
entered Warrant authority returns a rooted explicit no-op instead of failing
the workflow or inventing queue state.

The supported priority classes are `ordinary`, `expedited`, and `emergency`.
The queue does not infer an emergency: callers must choose it explicitly under
their reviewed policy. Delivery classes are `non-native-fast`,
`native-proof-required`, `cross-platform`, and `release`.

## CI lane change budget

`architecture/ci-lane-change-budget.json` pins the exact protected-Dev cut
that predates lane-budget enforcement. `scripts/check-ci-lane-change-budget.mjs`
compares the current workflow job set with that cut on every repository check.
Legacy jobs remain readable without invented metadata, while every newly added
job fails closed until its exact `<workflow>#<job>` lane declares:

- merge or non-merge authority class;
- trigger class;
- concurrency scope and `cancel-in-progress` behavior;
- expected runner-minutes per run;
- cancellation/settlement behavior; and
- merge-critical SLO impact, expected contribution, metric, and rationale.

The guard is repository policy only. It does not become another required
GitHub status, acquire merge-queue authority, or relax Delivery Warrant,
exact-head, approval, required-check, and protected-ref enforcement. A removed
lane must also remove its declaration, so stale budget records cannot conceal
workflow drift.

A release-blocker candidate may additionally carry a rooted priority claim
created from a settled Release Train dual landing. The claim binds the exact
Assignment, Initiative, repair, prior and successor cuts, candidate generation,
cut candidate, Dev head, semantic patch, both landing evidence roots, and
publication gate. Only a claim whose repository, protected base, Work roots,
head, patch, and claim root match the queued candidate enters the blocker lane.
That lane outranks not-yet-leased ordinary work, but never preempts or rewrites
an active Warrant; unrelated, conflicted, mismatched, or fabricated claims fail
closed before selection.

## Three proof authorities

Source Qualification Proof is created from the cheap source-acceptance gate. It
binds the semantic source, exact source head and patch/tree intent, plan,
affected closure, dependencies, toolchain, covered paths, and exact acceptance
evidence. Ready state and approval are established before provisional
selection.

Native Qualification Proof is separate. Its v4 form binds semantic source and patch,
plan, affected closure, dependency graph, toolchain, the exact execution
environment contract, covered paths, native shard evidence, the exact dev
base used by the native composition, and the v3 native heartbeat-run receipt.
That receipt exposes and roots the exact repository, protected base, source
head, qualified base, toolchain, and environment binding established before
process spawn. The proof carries the exact receipt bytes as well as repeating
the binding and receipt roots in its shard evidence. Public verification
recomputes those bytes and requires a successful outcome, positive heartbeat
count, exact command root, ordered start/completion/qualification timestamps,
and the complete execution binding; caller-computed roots without the receipt
bytes are not a v4 proof. Before reuse, the consumer roots the
complete attributed Dev delta, including both sides of every rename, then
classifies it:

- unchanged semantic roots plus an unrelated fully attributed base delta reuse
  native qualification and run only a cheap Project Cut replay. GitHub's `behind`
  state is accepted only when a rooted replay proof binds the exact current
  protected base, unchanged PR head and source patch, replay tree, required
  context roots, and a qualified `project.cut.merge-queue-admission/v1`
  receipt;
- an overlapping delta reruns affected native shards or the full native plan;
- an unknown or truncated graph, ambiguous rename, missing attribution, or
  changed source, plan, closure, dependency, toolchain, or environment root
  fails closed to full native qualification.

Historical Native Qualification Proof v1, v2, and v3 values remain readable,
but they cannot be reused because they do not carry the current v4 exact native
execution evidence. They fail closed to explicit native revalidation and
produce a v4 proof.

The reuse decision binds the exact old and current Dev heads, normalized changed
paths and rename pairs in `baseDeltaRoot`. This makes local and hosted replay of
the same inputs byte-deterministic. Generated outputs that participate in the
affected closure must be listed in `affected-paths-json`; a delta touching one
of those surfaces is overlap, not a documentation-only advance.

Integration Delivery Proof is separate and cannot be cached across candidates.
It binds the exact current dev base, replay tree, GitHub `merge_group` head and
tree, active Warrant fencing generation, Source Qualification Proof root, and
final required-context roots. GitHub's exact merge-group checks remain the
final integration authority.

## CLI

Queue commands are dry-run by default:

```sh
buildchain dev warrant submit --repository owner/repository \
  --branch dev/v4/v4.0 --pull-request 123 --source-head <sha> \
  --assignment-root <root> --initiative-root <root> \
  --source-identity-root <root> --source-patch-root <root> \
  --source-proof-root <root> --plan-root <root> --closure-root <root> \
  --dependency-root <root> --toolchain-root <root> \
  --environment-root <root> \
  --delivery-class native-proof-required

buildchain dev warrant select --repository owner/repository \
  --branch dev/v4/v4.0 --execute

buildchain dev proof native --branch dev/v4/v4.0 \
  --source-head <sha> --qualified-base <sha> \
  --environment-root <root> \
  --native-execution-receipt native-heartbeat-run.json \
  --affected-paths-json '["packages/native"]' ...

buildchain dev proof classify-native --source-proof native-proof.json \
  --current-base <sha> --graph-known true --attribution-complete true \
  --changed-paths-json '[]' --renames-json '[]' ...

buildchain dev warrant qualify --repository owner/repository \
  --branch dev/v4/v4.0 --fencing-token <root> --lease-generation 1 \
  --native-proof native-proof.json \
  --native-reuse-decision native-reuse-decision.json --execute

buildchain dev warrant cancel-queued --repository owner/repository \
  --branch dev/v4/v4.0 --candidate-id <root> --pull-request 123 \
  --expected-source-head <queued-sha> --observed-source-head <event-sha> \
  --expected-old <queue-root> --event-action closed --outcome cancelled \
  --evidence-root <terminal-event-root> --execute
```

`heartbeat`, `qualify`, `recover`, `close`, `settle`, `cancel-queued`, and `observe` use the same durable authority.
Warrant-scoped mutations require the exact fencing token and lease generation.
`close` also requires a rooted terminal evidence object.

On the v4 line, `observe` also has an explicit `--read-mode v4` candidate. It requires retained exact semantic-diff qualification and source binding, invokes the effect-disabled Rust projection, retains parity evidence, and returns the existing observation shape. The default and rollback mode remains `v3`; mutation commands ignore the read switch. See [`v4-delivery-warrant-read-candidate.md`](v4-delivery-warrant-read-candidate.md).

Expensive native commands must run through `dev-delivery-native-run.mjs` (or an
equivalent exact consumer). Before spawn it validates the environment and
execution roots and traverses the complete Linux `/proc` ancestry. An unreadable
process environment or status is a failure, as is any variable name containing a
generic auth, credential, key, password, secret, or token segment. The child
still receives only the fixed process-basics allowlist. The command root,
exact execution binding and root, successful outcome, child start and completion
times, and heartbeat count are included in the native receipt. The controller
keeps retained-fence heartbeats across the direct child lifetime and requires a
final successful heartbeat after child exit; process-group termination on fence
loss remains fail-closed runtime behavior rather than a claimed receipt field.

The reusable workflow does not run that controller in a credentialed job. A
GitHub-hosted `native-execution` job has read-only checkout permission, no
provider write credential in the candidate step or its ancestry, and cannot
qualify, settle, enqueue, or renew provider state. It copies only rooted proof
and Warrant bytes into a dedicated staging directory and uploads that closed set.
The success artifact contains exactly its transfer manifest, Warrant, native
result, native proof, and reuse decision; the failed-native artifact contains
exactly its transfer manifest, Warrant, canonical rooted failure, and
provider-settlement binding. Recursive verification rejects missing or extra
entries, duplicate or case-colliding paths, traversal, symlinks, directories,
other non-regular entries, non-canonical failure or manifest JSON bytes, byte
drift, and mutation between the first and second recursive membership
snapshots. A
dependent GitHub-hosted finalizer downloads those bytes and uses live
Actions job readback to prove different positive job ids, different runner
identities, a matching run attempt, and strict native-completion-before-finalizer
ordering. It recomputes the canonical failure root and binds that exact root,
transfer root, native job, Warrant state and fence into the live provider
boundary. Failure settlement consumes those verified coordinates directly; it
does not synthesize a second failure. The boundary also roots a live open-PR
head and protected-ref readback. The trusted finalizer uses its provider credential only for
those GET readbacks until the byte transfer, runner boundary, and semantic native
proof have passed independent verification. It then rereads the live PR head,
protected base, and Warrant fence before qualifying or settling. A missing or
corrupt artifact, unreadable `/proc`, same job or runner, invalid timestamp,
self-hosted label, stale PR/base/fence, or readback mismatch fails closed. Native
exit zero is only evidence input.

Proof commands create, verify, classify, and compose the two proof layers:

```sh
buildchain dev proof source ...
buildchain dev proof classify --source-proof source-proof.json ...
buildchain dev proof replay ...
buildchain dev proof replay-proof \
  --qualification-receipt project-cut-admission.json ...
buildchain dev proof integration --warrant-result warrant.json ...
```

## Opt-in bounded qualification and exclusive landing

Buildchain also defines an explicit production opt-in that turns successful
shadow evidence into a separate v2 authority state. It does not widen or
reinterpret the v1 Warrant queue. The accepted
[`Qualification Lease and Landing Warrant ADR`](dev-delivery-qualification-landing-adr.md)
and `contracts/dev-delivery-authority-v2.schema.json` are authoritative.

In `bounded-qualification-landing` mode, a configured number of exact
Qualification Leases may coexist. Each lease carries
`authority = qualification-only` and `mergeGroupAdmission = false`. Completing
qualification records evidence and releases that lease. Qualified candidates
then wait for the one `Landing Warrant`, which alone carries
`authority = merge-group-admission` and may be checked for `merge_group`
admission.

Concurrency is granted only across disjoint rooted `qualificationDomains`.
Overlap and unknown domains are held behind the active safety boundary with an
explicit content-rooted reason. `maxLandingOvertakes` prevents a slow older
candidate from being bypassed indefinitely, while `maxQualificationAttempts`
turns repeated heartbeat loss into a rooted terminal failure. Every release
returns a deterministic rooted wake instruction; an exact duplicate release or
recovery is a state-root-preserving no-op.

An expired qualification-only lease may release its bounded compute slot. An
expired Landing Warrant does not release exclusive provider authority by time
alone: recovery retains it and requires exact provider-stop or terminal
settlement evidence for the same token and generation before another landing
candidate can be selected. Expired cleanup invokes a separate independent
provider terminal verifier after candidate exit. Its rooted readback must match
the exact repository, protected base, authority state root, candidate, pull
request, source head, Landing token and generation, provider run and job, and a
fresh observation for that Warrant. Caller assertions, forged roots, wrong
bindings, nonterminal states, and stale observations cannot release the slot.
The verifier reads the immutable historical run-attempt endpoint. A later rerun
or synchronized PR head cannot rewrite the admitted attempt or prevent its
terminal settlement; current PR identity and protected base still must match.
The reader rejects an empty run conclusion, nonterminal run or job state,
unsupported job conclusion, or pull-request state outside `open|closed` before
it can seal product-owned cleanup evidence.

The public two-phase workflow keeps heartbeat authority in a fourth,
GitHub-hosted job on a runner domain distinct from admission, native execution,
evidence sealing, and finalization. Each successful heartbeat records the exact
expected-old and next authority state roots plus its receipt root. The
credentialless native job holds only its immutable admission binding; the
hosted coordinator alone renews durable state. After heartbeat loss it records
the exact current attempt but never invokes GitHub's run-scoped cancellation
API, so a successor rerun cannot be cancelled through a stale coordinate. All boundary jobs must prove the exact
`GitHub Actions` hosted runner group and reject `self-hosted`. The finalizer
rereads the provider job set and live authority state, rejects missing
or reordered receipt continuity, and requires the live state root to equal the
receipt's latest root before it can qualify, settle, or land.

A terminal native failure retains the complete provider chain through every
write-normalize-observe-remutate cycle: `transferRoot`,
`finalizerBoundaryRoot`, `nativeJobId`, `sealJobId`, the exact admitted
`providerAttempt`, and, when expiry cleanup was required, the independent
`providerTerminalReadbackRoot`.

Buildchain's tracked self-delivery caller invokes
`kungfu-systems/buildchain/.github/workflows/dev-pr-auto-merge.yml@v4-alpha`.
The durable selector remains the floating alpha channel, the repository keeps
matching `.buildchain/contract-lock.json` (`v4`) and
`.buildchain/alpha-contract-lock.json` (`v4-alpha`), and a train runtime may be
selected only through the trusted, non-persistent `workflow_dispatch` input.
No candidate SHA or train ref is persisted in the caller.

Only complete `verified-native-qualification` evidence can mint a new Landing
Warrant. Migrated `legacy-compatibility-only` evidence may preserve an exact
already-active historical Landing fence, but it cannot create a successor
Landing or acquire native proof authority.

The public command family is explicit:

```sh
buildchain dev authority migrate --repository owner/repository \
  --branch dev/v4/v4.0 --execute --json
buildchain dev authority submit --repository owner/repository \
  --branch dev/v4/v4.0 --environment-root <root> \
  --qualification-domains '["<root>"]' ... --execute
buildchain dev authority lease-qualification --repository owner/repository \
  --branch dev/v4/v4.0 --execute
buildchain dev authority heartbeat-qualification --repository owner/repository \
  --branch dev/v4/v4.0 --candidate-id <root> \
  --authority-token <root> --authority-generation 1 --execute
buildchain dev authority complete-qualification --repository owner/repository \
  --branch dev/v4/v4.0 --candidate-id <root> \
  --authority-token <root> --authority-generation 1 \
  --evidence-root <qualification-root> --execute
buildchain dev authority lease-landing --repository owner/repository \
  --branch dev/v4/v4.0 --execute
buildchain dev authority heartbeat-landing --repository owner/repository \
  --branch dev/v4/v4.0 --candidate-id <root> \
  --authority-token <root> --authority-generation 1 \
  --provider-attempt admitted-provider-attempt.json --execute
buildchain dev authority recover --repository owner/repository \
  --branch dev/v4/v4.0 --execute
buildchain dev authority admit-merge-group --repository owner/repository \
  --branch dev/v4/v4.0 --candidate-id <root> \
  --authority-token <root> --authority-generation 1 \
  --merge-group-head <sha>
```

Terminal settlement releases either authority immediately from exact evidence;
it does not wait for TTL. Exact duplicate settlement is a state-root-preserving
no-op. The default `buildchain dev warrant` commands, v1 state bytes, and
single-flight behavior do not change while this mode is off.

Migration also accepts the historical non-native v1 form whose active Warrant
predates the `phase` field. It preserves that exact fence as Landing authority
and records a schema-safe `legacy-compatibility-only` qualification carrying the
exact legacy state root, token, generation, source proof, and phase. Fields that
v1 never established remain explicitly null, including the phase-less
qualification time and every native proof field. A migrated qualified v1
Warrant retains its historical proof roots as compatibility facts, but
`nativeProofAuthority` remains false because migration cannot reconstruct the
v2 execution binding or qualification contract. Neither form can claim new
native proof or reuse authority. Phase-less native candidates remain invalid.

## Workflow rollout and rollback

The reusable `dev-pr-auto-merge.yml` supports three explicit rollout modes:

- `off` preserves the previous exact-head admission controller;
- `shadow` qualifies the source and emits a read-only queue submission plan;
- `required` persists the submission, selects a provisional Warrant, runs or
  reuses semantic native proof under heartbeat, atomically qualifies the same
  fence, and refuses GitHub enqueue unless the immutable queue commit, state root, active Warrant, and
  selected candidate all pass exact readback validation. Immediately before
  enqueue, the controller writes and then reads back both the exact-head queue
  admission status and active lease status. Only after those statuses are
  visible at their required states does it reread the pull request head,
  protected base, native merge queue, and current protected Warrant state. The
  final rooted admission transaction binds the frozen base, source head,
  candidate, fencing token, generation, native proof roots, Project Cut proof,
  and both status contexts. Status propagation is retried before enqueue;
  base, head, queue-predecessor, lease, or Warrant drift revokes both statuses
  without attempting enqueue. A previously valid result is not authority after terminal
  closeout. Re-running qualification for the same selected head may regenerate
  timestamped proof bytes, but it retains the immutable active Warrant and its
  originally selected proof instead of rewriting or rejecting that attempt.
  Each candidate also retains the exact successful source workflow run. If a
  controller discovers that another candidate owns the active Warrant, a
  configured consumer workflow is dispatched immediately for that exact PR,
  head, source run, Assignment and Initiative, source identity and patch,
  plan, closure, dependency, toolchain, environment, affected paths, delivery
  class, and priority; the candidate is not left waiting for a patrol cron.
  The shipped Buildchain caller and native template configure this handoff path
  and accept the same complete input contract. A historical phase-less owner
  uses the distinct `legacy-phase-less-active-owner` command path. That path
  carries the exact queue state root observed before its duplicate submission,
  fencing token, generation, PR, head, and source-run binding. The submission
  receipt proves that pre-transition root even though the queue transition
  advances the current state root. The path omits `environment-root`, `native-command`, and
  `native-command-root`, and rejects readback drift. It therefore resumes the
  historical non-native authority without inventing a native command contract
  or upgrading the owner to native proof authority.

  The PR-controlled native candidate runs in a distinct GitHub-hosted job with
  no provider write credential in the step or process ancestry. The dependent
  credentialed finalizer runs on another live-readback-proven GitHub-hosted job
  and runner, verifies the content-addressed transfer, then independently rereads
  the PR, protected base, and provider fence before qualification or settlement.
  Detached descendants, including descendants that unset runner tracking, remain
  in the native runner authority domain and cannot enter the fresh finalizer
  domain. Exit zero alone is never treated as provider mutation authority,
  Landing authority, or completed delivery.

  Persistent self-hosted runners are intentionally outside this contract. A
  `needs` edge alone does not prove process cleanup or a new authority domain, so
  the finalizer rejects a self-hosted label. Supporting self-hosted execution
  would require separately attested one-job runner destruction and a provider
  readback contract at least as strong as the GitHub-hosted boundary.

  Required-mode admission also performs a latest-base Project Cut immediately
  before enqueue. If the protected base advanced, the controller reclassifies
  the exact attributed delta against the rooted native proof. Only a disjoint,
  fully attributed move may reuse that proof; overlap, unknown attribution,
  missing composition, or merge conflict fails with a stable pre-enqueue reason.
  The rooted Project Cut receipt binds the frozen and admitted base SHAs,
  GitHub's exact synthetic merge commit and replay tree, and the unchanged PR
  head. A final base/head/queue/Warrant compare-and-swap readback must still
  match that receipt before the enqueue mutation is attempted.

  The protected branch ref is the base authority for that compare-and-swap.
  A pull request's `base.sha` may remain an older composition snapshot while
  GitHub reports the pull request as behind, so it is diagnostic rather than a
  substitute for the separately read protected ref and rooted Project Cut.

For a required native delivery class, the reusable controller rejects a
missing or malformed environment root before runtime checkout, candidate
submission, Warrant selection, or native execution. The input remains
conditionally optional so `off`, `shadow`, and `non-native-fast` callers keep
their documented behavior.

The controller persists a completed native proof before its final base
reclassification. A later exact retry can supply that proof and avoid the
expensive native command when the rooted delta still proves reuse safe. A
duplicate dispatch against the same already-qualified Warrant returns the same
proof and reuse roots plus a rooted qualification replay output without another
queue mutation. Both result forms carry
`landingAuthority: false`: only the live qualified Warrant plus exact-head
GitHub merge-queue admission can authorize landing.

The required controller checks the protected base again after native work. A
disjoint attributed delta reuses the proof. Overlap or unknown attribution
triggers one automatic revalidation on the latest base; continued overlap,
native failure, cancellation, semantic head movement, or an unrecoverable merge
conflict closes the exact fence. The next queued candidate is notified through
the `buildchain-dev-delivery-wake` repository event. Its complete semantic
candidate is carried under the single `client_payload.candidate` envelope so
GitHub's ten-property top-level limit cannot discard proof bindings. If
cancellation prevents cleanup, lease expiry recovers retained queue age and
mints a new fence.

Consumers should deploy `shadow` first, inspect receipts, then change their
protected caller to `required`. Rollback is a reviewed caller change back to
`off`; it does not delete queue history or reinterpret old receipts. The
terminal reusable workflow creates the exact Integration Delivery Proof for a
merged candidate (or accepts explicit evidence for another terminal outcome),
then closes only the current fencing generation. The separate queued
cancellation reusable workflow cannot close an active generation; it advances
the state ref only when the caller's complete terminal binding and expected-old
root still match. A delayed `dequeued` event is ignored when GitHub readback
shows the same exact PR head is already queued again, so an earlier queue event
cannot close a newer active Warrant generation.

Buildchain uses the same contract for its own protected dev line through
`buildchain-dev-delivery.yml`. The manual caller requires the exact PR head and
semantic source roots, accepts an optional reusable native proof, keeps both
the durable public selector and explicit runtime input on `v4-alpha`, selects
`delivery-warrant-mode: required`, and targets GitHub Merge Queue. It does not
offer an `off` switch: rollback is a reviewed change to this caller, not an
operator-time weakening of a specific delivery attempt.

`templates/native-dev-delivery.yml` provides the corresponding protected-dev
consumer workflow. It supports both explicit dispatch and the bounded wake
event, calls the allowed floating `@v4-alpha` selector, explicitly passes the v4
runtime ref that locks every delivery job to the same checkout, and keeps the
native command in the consumer repository rather than inventing
provider-specific shards. Both callers explicitly bind the queue-admission
and active-lease status contexts so write/readback fencing uses the same exact
names. The reusable workflow defaults the explicit runtime input to
`v4-alpha`; an empty input or any v3 selector fails before the first runtime
checkout.

This mechanism schedules protected delivery only. It does not serialize local
development, source-only checks, unrelated channels, release publication, or
runner provisioning. It never grants authority to enable cloud runner
campaigns.
