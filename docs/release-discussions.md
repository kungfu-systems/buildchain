---
status: draft
period: ongoing
theme: release-discussion-transactions
doc_type: implementation-contract
source_level: user-consensus
confidence: medium
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-12
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-12
  visible_context: Release workflow implementation and agreed consumer Discussion transaction model.
  invisible_context_boundary: Hosted token qualification and alpha publication are not claimed by this document.
---

# Release Discussion transactions

One release intent owns one Discussion in the consumer repository. Its immutable
body declares the intent and the complete expected semantic node list. The
Announcements category is resolved by the initialization service; subsequent
operations receive the exact Discussion ID. Categories have repository-specific
IDs. Enable Discussions and retain the Announcements category before executing a
release. A preview performs no Discussion reads or writes.

The caller grants `discussions: write` to the reusable workflow job alongside its
existing release permissions. The called workflow uses the consumer's automatic
`GITHUB_TOKEN`. Checking out Buildchain does not change that repository or token.
A reusable workflow cannot elevate the permissions granted by its caller.

```yaml
jobs:
  release:
    permissions:
      contents: write
      discussions: write
      actions: write
      id-token: write
    uses: kungfu-systems/buildchain/.github/workflows/public-release-promote.yml@v4
    with:
      request-json: ${{ inputs.request-json }}
      runtime-ref: ${{ inputs.runtime-ref || '' }}
```

This fragment illustrates the additional Discussion permission; retain other
permissions required by the consumer's publication provider. The platform
contracts are documented in GitHub's [reusable workflow reference](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
and [Discussions API guide](https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions).

## Records and concurrency

The body is not a mutable global status document. New intents declare `organization: attempt-threads/v1`. Each attempt owns exactly
one top-level root comment; node events, checkpoints and diagnostics are appended
as replies using that root comment ID. Workflows append bounded JSON envelopes
with readable context and evidence links. Each record contains an intent ID, workflow attempt,
predecessor, semantic node, sequence, status, payload schema, and the selected
runtime's exact repository and revision. These are provenance; downstream nodes
do not compare the runtime revision with the workflow entry revision.

Node owners serialize their own sequences. Different node owners append
independent replies under the same attempt root. Recovery explicitly selects the predecessor in the same
Discussion. A late result from an older attempt remains history; it cannot
complete or overwrite the recovering attempt. Success requires every declared
node, including nodes whose records have not appeared. Reusing completed work
requires explicit qualification by the recovering runtime.

The release controller must serialize initialization for one intent. GitHub does
not supply a unique constraint, compare-and-swap or exactly-once mutation API.
Initialization scans complete repository category pages, reuses the matching
intent, and refuses duplicate owners. A mutation whose response was lost is read
back before another write. If its outcome remains unknown, execution stops with
an explicit diagnosis. `clientMutationId` is not used as an idempotency guarantee.
The attempt owner creates the root before dispatching independent node writers.
Root creation is serialized and response-loss recovery reads it back. Different
roots for one attempt, nested roots and events attached to the wrong attempt are
rejected. Root and reply connections are both completely paginated; individual
page and total byte bounds fail closed. Community conversation is ignored.

Exact IDs carry the transaction through execution; search indexing is not an
execution dependency. Pagination limits fail closed instead of silently hiding
records. Only records from the original workflow writer are authoritative;
ordinary community replies are excluded and edited transaction records are
reported as integrity failures.

## Human-readable information hub

The Discussion body declares the release intent and expected nodes. Each root
links its workflow execution, selected runtime and predecessor attempt. Replies
name the semantic node, distinguish checkpoint sequence from execution status,
and expose bounded details. An independent binary workflow links its own run but
replies to the release attempt it observed before starting; a late completion
cannot migrate into a successor attempt.

Checkpoint replies include downloadable JSON attachments with file names, media
types, byte counts and SHA-256 digests. On node failures, the same thread receives
JSON diagnostics and a text `.log` containing the recorded event timeline and
bounded failure classification. Raw exceptions, environment variables and HTTP
credentials are not copied into diagnostics. Complete execution logs remain
linked through their Actions runs. Qualification also exercises JSON/log downloads.

Automation uploads these files through the documented GitHub Release asset API
and embeds the provider's download links in the owning comment. This does not
use GitHub's browser-only drag-and-drop upload implementation. The existing draft
material archive is private to users with the required repository access; a
public Discussion does not make draft attachments publicly downloadable. Download
links require that permission and files remain outside the source Git database.

Root comments and event replies are immutable execution facts. The latest state
is computed from records, not from an overwritten status summary. Historical flat
intents remain readable as historical data; all new writes use an attempt root
and replies, and new intents enforce that organization. No historical Discussion
body or comment is rewritten to change its layout.

## Recovery bytes and historical readers

Large sealed inputs and provider checkpoints are retained as immutable,
content-addressed assets in a draft material archive associated with the intent.
The archive is storage, not publication state. A Discussion checkpoint commits
the exact material manifest after upload and byte readback. Failed uploads can
leave unreferenced material but cannot commit an incomplete checkpoint. No
transaction-log history is added to the consumer's source Git object database.
Actual version-code commits and publication refs retain their existing roles.

Each runtime distributes the standalone `dist/readers/release-discussion.cjs`.
The same pure reader is available as the versioned Node API
`@kungfu-tech/buildchain/release-discussion-reader`. Records carry the standalone
reader byte digest. The recovery archive retains the exact reader bytes and the public
release includes the first retained reader asset. Recovery preserves those public
bytes while retaining each later writer's decoder in the archive. The standalone reader accepts captured JSON
on standard input and emits a projection and a small
`buildchain.release-handoff/v1` document. It performs no provider effects.

```sh
node --permission --allow-fs-read=/absolute/path/release-discussion.cjs \
  /absolute/path/release-discussion.cjs < captured-discussion.json
```

A payload with a different schema belongs to its recorded historical reader.
The current runtime does not silently reinterpret it. Historical decoding and
new execution are separate: the recovering runtime consumes a supported handoff,
qualifies original source and material, and reads providers before issuing any
remaining effects. Switching runtime X to Y creates new attempt records in the
same Discussion. It neither rewrites X's records nor changes the release intent.

## Ownership

`actions/release/transaction/{open,record,inspect}` are reusable Node adapters.
`packages/core/release/discussion` owns envelopes, pure state projections, sessions, thread organization,
presentation, declared evidence and recovery contracts. `threads.js` checks
provider placement; `presentation.js` renders contextual Markdown; `evidence.js`
builds bounded attachment descriptors and diagnostic reports. `packages/core/providers/github/discussions` owns GitHub
transport and immutable material IO. The existing public promotion workflow
owns job boundaries; the Rust publication state machine still owns publication
decisions and provider-effect ordering.

The public Bootstrap API also exposes the `release-discussion` capability for
consumer transport qualification and read-only diagnosis. Buildchain's existing
Bootstrap dogfood caller accepts this request through its manual
`request-json` input, preserving the same public entry and central
runtime preparation as other consumers.

## First publication with a selected runtime

For Buildchain self-publication, dispatch `self-release-promote.yml` with the exact
protected alpha `sha`, its `target-ref`, `dry-run: "false"`, and the desired
`runtime-ref`. Leave recovery selectors empty for a first publication. The public
publisher still verifies the protected source and obtains fresh hosted admission.
`recover-durable-transaction` is reserved for an existing partial publication;
it is not required merely because the selected runtime differs from the entry.

## Resume by Discussion

Pass `resume-discussion-id` in the public promotion request and select the repaired
train through `runtime-ref`. Keep the protected target ref and source coordinates.
The qualifier restores content-addressed candidate material, verifies original
qualification, then re-observes providers before any remaining publication effect.
Do not combine this selector with candidate-run or transaction-id recovery.

When standalone binary distribution is requested, the intent also requires the
`binary-distribution` node. Its separate workflow resolves the immutable locator
from the public release, captures the active attempt, and appends provider readback
to that attempt. A result arriving after recovery stays on the older attempt.
The terminal publication receipt remains independently verifiable even while
next-development or binary distribution is incomplete.

The manual Bootstrap caller inherits the declared repository workflow permissions;
the typed capability request must declare its own subset. `verifyMaterials: true`
on a qualification request additionally tests draft Release asset retention using
`contents: write`. The initial injected failure is intentional and leaves durable
records for a subsequent runtime recovery probe.
