---
status: active
period: ongoing
theme: buildchain-v4-production-release
doc_type: runbook
source_level: repository-contracts + protected-provider-readback
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-09-05
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-05
  invisible_context: Provider credentials and private provider state were not read.
---

# Buildchain v4 production release

Buildchain v4 is the production release authority for the `v4.0` line. The
protected source path is:

```text
dev/v4/v4.0 -> alpha/v4/v4.0 -> release/v4/v4.0
```

Public consumers use `v4-alpha` for the current prerelease channel and `v4`
for stable, with matching stable and alpha contract locks. Exact commits and
immutable release tags identify retained evidence and explicitly admitted runtime
inputs; tracked v4 reusable-workflow selectors remain `@v4` or `@v4-alpha`.

The release transaction is fail-closed. The v4 provider-operation journal,
activation plan, stable publication fence, and partial-mutation recovery plan
bind the exact source, qualification, policy, provider readback, protected
ancestry, and target roots. Confirmed operations are never replayed; uncertain
operations require provider readback before retry; stable publication requires
an N-1 or independently sealed qualification.

## Provider readback

A stable release is complete only when all of these coordinates agree:

- `release/v4/v4.0`, `v4`, `v4.0`, and the exact `v4.0.x` tag;
- the GitHub Release tag and attached Release Passport evidence;
- npm `@kungfu-tech/buildchain@4.0.x`, its `gitHead`, and the `latest` tag;
- the protected source and release transaction roots.

The alpha channel applies the same rule to `alpha/v4/v4.0`, `v4-alpha`, the
exact alpha tag, and npm's `alpha` tag.

## Non-destructive rollback

Rollback never rewrites an exact tag, release, package version, Passport, or
provider journal. Stop forward promotion and select the last verified exact
v4 runtime through an admitted, non-persistent recovery input; keep tracked v4
workflow selectors on their locked floating channel. Use `release/v3/v3.0`
coordinate only as an explicit compatibility rollback reference. Restoring v3
as production authority requires a new reviewed cutover; it is not an implicit
fallback.

Before any retry, compare the current provider state with the retained
transaction and operation roots. Resume only missing eligible operations.
Conflicting state remains `repair-required` or terminal and must not be
converted into success by moving a floating ref.

## Publication settlement and binary recovery

Publication, next-development advancement, and binary distribution have separate
results. A completed native ReleaseReceipt remains publication evidence when the
later generated Dev PR is still pending or its enqueue call fails. SETTLE verifies
the immutable invocation, transaction, both provider states, receipt and Passport
roots even when APPLY fails after publication. It has no provider write permission.

APPLY retains that exact chain before waiting for next-development in the existing GitHub Release as
`buildchain-publication-settlement.json`; it reads the exact tag and original
`buildchain.release.json` before adding the packet. The APPLY artifact also retains
`delivery-summary.json`, which reports publication and next-development separately.
A green workflow label cannot substitute for this receipt verification.

Binary Distribution reads this settlement and the original publication Passport.
Tag creation can precede settlement, so it waits at most 40 observations, 15 seconds
apart, for missing evidence. A mismatched source, tag, Passport or receipt fails
immediately. It no longer requires a legacy `buildchain/release-state/*` ref for v4.

The sealed binary publisher retains the publication Passport and writes its own
Passport as `buildchain.binary.release.json`. All v4 asset collisions are checked
before uploads: identical bytes are preserved, absent assets are added, and
conflicting bytes are rejected. Each publication authorization is retained as
`buildchain.binary.capability-<sha256>.json`, so a fresh recovery capability does
not overwrite an earlier grant. Existing assets are never clobbered. Recovery uses
the same exact successful Binary Distribution evidence run through
`self-release-binary-assets.yml`; it does not rebuild already admitted archives or
create another npm version. Read back all three platform archives, checksums,
both Passports and the settlement packet before declaring distribution complete.

The native publication receipt authorizes no stable promotion and makes no claim
that a pending next-development PR has merged. Inspect the exact PR head, protected
base and merge result independently. A retry of the publication phase must first
read retained provider facts and resume only missing operations.

## Automatic next-development review

`self-release-next-development.yml` observes a successful exact `Verify` PR run
for a same-repository `chore/next-development/*` branch. It executes only the
protected default branch runtime. The PR must have one parent equal to the
current protected Dev head. The protected generator reconstructs every tracked
byte, permits only the declared immediate alpha version increment, and verifies
the completed alpha settlement against the exact tag and original Passport.
The published source tree must equal the protected development base tree.

The verification step receives no approval credential and never executes PR
code. A separate step uses `BUILDCHAIN_APPROVAL_TOKEN`, verifies that its identity
is the independent `kungfu-origin` CODEOWNER, rereads the exact PR/run/base, and
approves only that commit. Existing requests for changes stop automation.
The exact approval is read back before queue admission with the separate
`BUILDCHAIN_PROMOTION_TOKEN`. Required checks, CODEOWNER protection and native
merge-group verification remain enforced. Missing credentials or evidence,
forks, source changes and base/head drift fail closed.

The producer waits for pending independent review and required checks with a
bounded retry budget. Publication evidence is already durable during this wait,
so binaries can proceed independently. The reviewer also enqueues the verified
head idempotently, allowing a producer interruption to leave a recoverable PR.
An interrupted producer run remains failed; a successful later release is needed
to establish an uninterrupted end-to-end publication.
