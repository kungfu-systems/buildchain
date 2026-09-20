---
status: active
period: ongoing
theme: buildchain-release-governance
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
  visible_context: Schema-2 consumer contract, pipeline and recovery entries, and internal release implementations.
  invisible_context_boundary: No unobserved hosted publication or external consumer migration is claimed.
---

# Release Governance

A reviewed channel PR expresses delivery or release intent. Buildchain manages
source qualification, protected landing, version material, publication, provider
readback and recovery through one normal pipeline.

## Consumer contract

Consumers maintain three files: `.buildchain/buildchain.toml`, the generated
`buildchain.yml`, and the generated `buildchain-recover.yml`. Tool-maintained
contract locks and one-time provider permissions are separate setup facts.

The only public reusable workflows are `public-ops-pipeline.yml` and
`public-ops-recover.yml`. npm packages, binary assets and Paper PDFs share these
entries. Their product differences are declared in TOML and ordinary product
source. See [Getting started](getting-started.md).

Internal actions and workflows are implementation details. Consumers do not add
patrol, promotion, attestation, candidate or product-specific release callers;
they do not pass Warrant, proof, payload handoff or arbitrary request JSON.

## Design Problem

A release must agree on the reviewed source, version material, exact tags,
published bytes and floating channel refs. A successful test or a merged PR
proves only its own stage. Buildchain records source and runtime identities and
reads providers back before accepting publication or terminal settlement.

## Version Lines

| Intent | Source | Target |
| --- | --- | --- |
| Development | `feature/*`, `fix/*`, `chore/*`, `docs/*`, `ci/*`, `refactor/*` | configured `dev/vX/vX.Y` |
| Alpha | `dev/vX/vX.Y` | `alpha/vX/vX.Y` |
| Stable | `alpha/vX/vX.Y` | `release/vX/vX.Y` |
| Major | `release/vX/vX.Y` | `publish-gate/major` |

The schema-2 channel declaration admits only legal branch pairs. `dev` is a
protected development channel; work is proposed from an isolated task branch.
`publish-gate/major` is an explicit major-release decision, not a development trunk.

## Buildchain Implementation

The generated normal entry handles source events and invokes the shared runtime.
The runtime owns internal build, delivery and publication jobs while retaining
independent reviews, merge queues, credential isolation and exact-source checks.
An internal split across several jobs or workflows does not add consumer wiring.

The TOML compiler is closed: products declare install/build/verify commands,
artifacts and supported publication targets; version files and channel policy
are explicit. Consumer commands do not implement registry publication, evidence
packaging, provider readback, event routing or recovery. The schema is described
in the [CLI manual](cli.md) and [product publication guide](publication-artifacts.md).

## Protected Dev Branches

The declared review policy requires independent approval, Code Owners and a
protected merge queue. The runtime validates current source/base identity and
the provider's review/check state before landing. A queue admission or a pending
check is not a merged delivery. Repeated, stale and out-of-order events remain
bound to their own source and attempt.

Buildchain's Warrant, fencing and native-proof mechanisms are internal scheduling
and authority boundaries. Their [implementation contract](dev-delivery-warrant.md)
and [node orchestration](dev-delivery-orchestration.md) do not require additional
consumer scripts or allow a caller to forge proof or bypass protection.

One-time permission or provider setup must preserve these review and credential
boundaries. It does not become a recurring consumer runtime step.

## Alpha Semantics

A legal development-to-alpha PR requests a fresh prerelease. The runtime owns
version materialization, product qualification and publication. Exact alpha tags
and published package versions are immutable evidence; floating alpha refs
identify the published channel. A later alpha is a new publication, not a rewrite
or repair of an earlier failed version.

### Buildchain public build self-dogfood

Buildchain consumes the same generated normal/recovery pair and schema-2 policy.
Its product commands verify Node, Rust and the required Linux/macOS/Windows
artifacts. Runtime locks, source identities and hosted evidence remain separate;
self-consumption has no repository-specific runtime-selection exception.

## Release Semantics

A legal alpha-to-release PR requests stable publication. The runtime validates
its source, admitted material and version-bound evidence before provider effects.
Existing published payloads and receipt bytes remain immutable on recovery.

### Stable Release Evidence Gate

The stable policy requires product impact and qualified published-entry evidence
bound to the selected source/runtime. `.buildchain/buildchain.toml` declares the
current policy, with supporting version-bound impact in
`.buildchain/release-impact.json`. Buildchain currently declares both minimum
interval and soak as zero: valid evidence can proceed without a fixed delay.

The [stable-entry implementation](../packages/core/publication/pipeline/stable-entry.js)
checks the published entry; an old standalone dogfood workflow name or a green
local test is not a substitute. Publication and its later distribution and
next-development stages retain separate completion facts.

Stable completion prepares the next patch's `alpha.0` using the current protected
development source and declared version paths. Concurrent development must be
preserved. See [Next-development transition](next-development-transition.md).

## Major Gate Semantics

A release-to-major-gate PR is the reviewed intent to publish the next major.
The runtime applies the same exact source, version, provider and protected-ref
boundaries. A branch name or manual workflow dispatch alone is not authority.

## Failure and recovery

Use `buildchain-recover.yml` with the exact `attempt`. Supply the optional
`runtime-ref` only when a repaired runtime is needed. Recovery restores original
material and reads providers before remaining effects; it does not replace
source or published payloads. Consumers do not supply run/Discussion/transaction
selector combinations or custom recovery scripts.

New work uses a new attempt/version. Historical incomplete attempts and already
published versions are not silently retargeted to new source. See
[Consumer recovery](bootstrap-recovery.md) and [Release discussions](release-discussions.md).

## What This Guarantees

Successful terminal evidence binds the intended protected source, selected
runtime, artifacts, provider observations and required stage results. Exact tags,
registry integrity and immutable Release assets must agree with their recorded
publication. An existing asset may be reused only when its bytes agree; an
immutable collision is a failure, not permission to replace it.

## What This Does Not Do

Local checks do not prove hosted review, publication or recovery. Publication
completion does not by itself prove next-development or binary distribution.
A dispatch, queued job, generated envelope or successful API response is not
terminal provider evidence. The runtime must retain and verify those facts.

## Operational Reading Order

1. [Release flow](release-flow.md) and [consumer setup](getting-started.md).
2. [Public pipeline](../.github/workflows/public-ops-pipeline.yml) and
   [attempt recovery](../.github/workflows/public-ops-recover.yml).
3. [Pipeline implementation](../packages/core/workflow/pipeline/).
4. [Publication implementation](../packages/core/publication/pipeline/).
5. [Release discussions](release-discussions.md), [publish transactions](publish-transaction.md)
   and [next-development](next-development-transition.md) for internal evidence.

Earlier v3 wrappers, lifecycle publication scripts and self-only promotion
workflows are retired consumer interfaces. Historical implementation records
remain in Git; they are not alternate setup instructions for this contract.
