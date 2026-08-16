---
status: preview
period: 2026-08-16
theme: buildchain-v4-publication-rehearsal
doc_type: product-manual
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-16
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-16
  visible_context: Exact v3 rehearsal runtime, v4 release-tail core, Stage Capsule contracts, public workflow and offline vectors.
  invisible_context_boundary: No credentials, private provider state, signed URLs or production publication receipts were read.
---

# V4 Publication Rehearsal Capsule

The v4 Publication Rehearsal Capsule is the content-addressed input for
testing publication behavior without acquiring production publication
authority. It is deliberately not a Stage Capsule. A Stage Capsule retains a
pure platform-stage build checkpoint; a Publication Rehearsal Capsule binds a
release candidate and asks the production release-tail planner and executor to
simulate, replay, or observe provider-facing publication behavior.

The rooted parity matrix is
[`architecture/v4-publication-rehearsal-parity.json`](../architecture/v4-publication-rehearsal-parity.json),
and the public schema is
[`v4-publication-rehearsal-capsule-v1.schema.json`](../contracts/v4-publication-rehearsal-capsule-v1.schema.json).

## Bound identity

One capsule commits to all of these values:

- its own canonical capsule root;
- the exact source repository, Git revision, and source root;
- the sorted candidate file inventory and candidate root;
- the exact candidate manifest and Buildchain config paths and roots;
- the canonical data-only provider bindings and `providerBindingsRoot`;
- the effect-disabled provider policy and its exact capability/adapter set;
- expected provider observations and their root;
- the initial transaction produced by the production release-tail planner;
- `buildchain.release-tail/v1` as the shared core version.

Changing any one of those values, or changing a candidate byte, fails closed.
Candidate paths must remain regular non-symlink files below an explicit
absolute root. Every artifact, provider document, and released-evidence input
named by the bindings must also appear in the rooted file inventory. The
evidence output may be absent, but its path and every existing ancestor must
remain below that root without symlinks.

## Modes and authority

`simulate` uses in-memory adapters and makes no provider call. `replay` feeds a
recorded response sequence through the same production transaction executor.
`provider` requires a capsule-bound
`buildchain-v4-publication-rehearsal-authority/v1` receipt plus the declared
provider adapters. The authority binds `providerBindingsRoot` directly as well
as through `capsuleRoot`, so request bytes cannot be replaced while retaining
authority. It is rehearsal-only: its
`productionAuthority` field is always `false`, and it binds a separately
supplied live `authorizationRoot` rather than minting authority from the
capsule alone.

Every provider readback and apply request is retained in the rooted transcript.
The resulting evidence always contains `productionAuthority: false` and
`releasePassport: null`. It therefore cannot publish by itself, authorize a
production release tail, or stand in for a Release Passport, protected
readback, or Delivery Warrant.

## CLI and Node API

Local simulation and replay use the public `release-tail` command:

```sh
buildchain release-tail rehearse \
  --capsule "$PWD/contracts/fixtures/v4-publication-rehearsal-v1/capsule.json" \
  --candidate-root "$PWD/contracts/fixtures/v4-publication-rehearsal-v1/candidate" \
  --mode simulate \
  --state "$PWD/.buildchain/publication-rehearsal/state.json" \
  --evidence "$PWD/.buildchain/publication-rehearsal/evidence.json"
```

Applications import `@kungfu-tech/buildchain/v4-publication-rehearsal` to
create and verify capsules, create provider-rehearsal authority, and execute
all three modes. The API delegates planning, transaction initialization, and
execution to the same `release-tail-provider-plane` functions used by the
production Action.

## Config and public workflow

The consumer config is closed and effect-disabled:

```toml
[publication_rehearsal]
contract = "buildchain-v4-publication-rehearsal-capsule/v1"
capsule_path = "contracts/fixtures/v4-publication-rehearsal-v1/capsule.json"
candidate_root = "contracts/fixtures/v4-publication-rehearsal-v1/candidate"
state_path = ".buildchain/publication-rehearsal/state.json"
evidence_path = ".buildchain/publication-rehearsal/evidence.json"
effect_default = "disabled"
```

The public reusable
[`release-tail.yml`](../.github/workflows/release-tail.yml) accepts the same
capsule, candidate root, mode, state and evidence paths. Before publication,
Buildchain dogfoods that public surface through a thin same-commit local reusable
call with the exact PR-head or dispatch SHA as its runtime. Durable external
consumers remain on the floating `@v4-alpha` contract. Provider mode additionally
requires the exact authority path. Provider bindings come from the capsule; an
optional external bindings input is accepted only when its canonical exact
root and payload equal the capsule binding. Ordinary calls default to
`simulate`.

## Offline portability vectors

[`offline-vectors.json`](../contracts/fixtures/v4-publication-rehearsal-v1/offline-vectors.json)
records Linux, macOS and Windows projections. Their capsule, transaction,
state, and evidence roots are byte-identical. Regenerate or verify them with:

```sh
node scripts/v4-publication-rehearsal-fixture.mjs
node scripts/v4-publication-rehearsal-fixture.mjs --check
```
