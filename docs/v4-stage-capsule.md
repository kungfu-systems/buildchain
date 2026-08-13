---
status: draft
period: ongoing
theme: buildchain-v4-stage-capsule
doc_type: contract-guide
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-10
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-10
  invisible_context: not asserted
---

# Buildchain v4 Stage Capsule

## Platform checkpoint projection

`architecture/v4-platform-stage-checkpoints.json` is the single declaration
for the macOS arm64, Linux x64, and Windows x64 shadow checkpoint lanes. It
defines the allowed platform/stage pairs and the exact declared inputs,
outputs, environment names, toolchains, and portable restore paths.

The protected `Verify` workflow runs each platform on its real hosted runner.
After a declared successful stage, the TypeScript v3 writer emits the canonical
Capsule and immutable local-store receipt. A separate Node process restores the
declared output layout into an empty directory and verifies every blob and
manifest root. A failed stage emits no Capsule; a later failure does not remove
earlier successful stage Capsules.

This is shadow evidence only. It records per-platform/stage overhead and asserts
that production bytes did not change. It does not skip production stages, read
ambient runner state, include provider credentials, perform signing or
publication, or grant provider/cache presence qualification authority. The
generated consumer workflow and Agent guidance point back to the same
declaration; undeclared fields fail closed.

A Stage Capsule is the immutable, per-platform evidence contract for one build
stage. It does not store artifacts, plan resume, publish provider state, or move
production write authority. TypeScript v3 remains the sole writer; Rust is a
pure validation and root-projection implementation.

## Three separate roots

The contract deliberately keeps three facts separate:

1. `identityRoot` binds source, platform, stage, toolchain, runtime, policy,
   declared inputs, transformation, output manifest, qualification, and any
   explicitly declared rooted observations.
2. `capsuleRoot` binds that immutable identity and the retention promise.
3. `availabilityRoot` binds a caller-supplied observation of current
   availability, content, qualification, and rooted transport locators.

Changing platform, stage, policy, transformation, or a declared input changes
the identity root. Changing an observation time or transport locator changes
only the availability root. A provider run ID, provider artifact ID, runner
path, credential, ambient clock, raw network observation, mutable tag, or cache
hit is not a schema field and therefore cannot silently become identity.
Provider evidence participates only as an explicitly named observation root.

## Retention and reuse

A retention promise is not proof that bytes currently exist. Reuse is a pure
decision over an explicit evaluation clock and a current availability
observation. It is eligible only when the capsule, output-manifest, and
qualification roots all match, the observation is `available`, and the
retention promise has not expired. `missing`, `expired`, `corrupt`, and
`root-mismatch` always fail closed. Transport locators are rooted observations,
not artifact authority.

The sole schema authority is
[`v4-stage-capsule-v1.schema.json`](../contracts/v4-stage-capsule-v1.schema.json).
The shared fixture is consumed by both implementations. The next Wave 2 cards
may add checkpoints, resume planning, and reconciliation, but must not weaken
or duplicate this contract.

## Content-addressed reference store

The storage successor adds one closed output-manifest and store contract suite
without changing Capsule identity. Raw blob bytes use lowercase SHA-256 roots;
the canonical output manifest binds byte roots, sizes, and sorted names, and its
`manifestRoot` must equal the Capsule `outputManifestRoot`. The local reference
store writes immutable `blobs`, `capsules`, `manifests`, and `records` families
under exact roots. A fresh process can restore by `capsuleRoot`, then re-verifies
the Capsule, manifest, every byte root, retention state, availability, transport
observation, and qualification root before returning bytes.

Repeated put and restore are idempotent. A different physical store directory
does not change Capsule or manifest identity. `missing`, `expired`, `partial`,
`corrupt`, `quarantined`, and `root-mismatch` are deterministic fail-closed
classifications; there is no cache fallback. Retention promise, evaluated
retention state, current availability, rooted transport locator, qualification,
and operation receipt are different roots with caller-supplied clocks.

GitHub Artifact and S3-compatible adapters expose only `effect-disabled` and
`fixture-backed` modes in this slice. They accept rooted locators, never raw
credentials or signed URLs, and cannot perform a provider upload or restore.
The executable architecture ceiling is
[`v4-stage-capsule-store-contract.json`](../architecture/v4-stage-capsule-store-contract.json),
and the shared Rust/JavaScript fixture is
[`shared.json`](../contracts/fixtures/v4-stage-capsule-store-v1/shared.json).

Focused verification:

```sh
pnpm run check:v4-contracts
```

## Deterministic resume planning

`architecture/v4-stage-capsule-resume-planner.json` closes the Wave 2 resume
planner. Its request is an explicit topological stage graph with targets,
expected Capsule identity and retention, current Capsule/availability
observations, an evaluation clock, and separately declared provider or
release-tail effects. The Rust domain core and TypeScript projection consume
the same request without filesystem, network, environment, or ambient-clock
access and produce the same ordered decisions and `planRoot`.

An eligible completed dependency becomes an exact-root restore; a missing or
invalid target becomes a rebuild, and only that target's dependency closure is
scheduled. Source, platform, toolchain, runtime, policy, declared-input,
transformation, output-manifest, and retention changes carry rooted causal
invalidation fields. Cross-platform reuse, corrupt or partial content, root
mismatch, and insufficient qualification reject reuse fail closed.

Effects never participate in Capsule reuse. They remain ordered declarations
with required provider readback and planner mutation disabled. This planner is
shadow-only: it does not skip a v3 production stage or move v3 authority.

## Three-platform qualification and Wave reconciliation

`architecture/v4-stage-capsule-qualification.json` closes the Wave 2
qualification boundary. Buildchain and external repositories use the same
Buildchain-owned public reusable workflow,
`.github/workflows/v4-stage-capsule-canary.yml`. Buildchain's caller is the thin
`.github/workflows/v4-public-consumer-dogfood.yml`; it has no steps, copied
orchestration, local action, direct qualification invocation, or private
consumer profile. Candidate recursion is resolved only by publishing the exact
candidate at `train/v4/v4.0/<capability>` and calling that fully qualified
public ref. After successful qualification and protected merge, the caller can
be pinned to the exact protected commit. An internal exception is never a
permitted recursion mechanism.

The called workflow checks out that same commit as its runtime, reads the consumer's
tracked `.buildchain/buildchain.toml`, and executes only `install`, `build`,
and `verify` on GitHub-hosted Linux x64, macOS arm64, and Windows x64 runners.
Each stage binds its declared command, dependency edge, exact consumer source,
platform, lifecycle manifest, summary, and real output roots into the campaign
profile. `publish` is explicitly classified as a provider mutation and is not
executed. The caller supplies only its stable consumer name and the real output
paths; it does not copy the campaign orchestration.

The external seed retains `install` and `build` before an intentional late
`verify` failure. A clean process reads the retained store, restores only the
exact `build` root, rebuilds `verify`, and compares the result with the fresh
three-stage aggregate. Runtime-ref, source, command/profile, manifest, summary,
output, platform, and Capsule-root drift all stop with typed diagnostics.

Qualification compares the declared artifact-manifest and aggregate content
roots from a fresh full build with the roots assembled from retained and rebuilt
Capsules. It fails closed on missing, expired, corrupt, partial, cross-platform,
cross-stage, source/toolchain/policy drift, stale-writer, and root-mismatch
campaigns. The rooted report records retained bytes, restore overhead, planner
accuracy, false reuse, and false rebuild counts. Every invocation declares one
exact public consumer identity and requires its Linux, macOS, and Windows
reports before emitting a qualification root. Buildchain declares `buildchain`
and receives no additional profile or authority.

The post-merge reconciliation interface accepts that qualification root only
with all five Wave 2 children in native terminal state, exact source and
protected merge revisions, independent review roots, Delivery Warrant roots,
native gate roots, and an empty protected-delivery queue. It emits evidence; it
does not rewrite child authority. `--stage-capsule-mode v3` is the explicit
non-destructive rollback switch. No migration, retained-state deletion,
production reuse, provider effect, release effect, or v3 behavior change is
authorized by this qualification.

Focused local rehearsal:

```sh
node scripts/v4-stage-capsule-qualification.mjs campaign \
  --work-root /tmp/buildchain-v4-stage-qualification \
  --platform linux-x64 \
  --consumer buildchain \
  --runtime-ref <exact-buildchain-commit> \
  --consumer-source-revision <exact-consumer-commit> \
  --consumer-root . \
  --lifecycle-evidence-root .buildchain/artifacts/v4-stage-capsule-canary
```
