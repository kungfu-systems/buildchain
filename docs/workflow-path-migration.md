---
status: draft
period: ongoing
theme: workflow-path-migration
doc_type: migration-guide
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-06
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-05
  visible_context: Exact GitHub channel refs and workflow files on 23 organization default branches
  invisible_context_boundary: Other branches, private or unlisted consumers and future floating ref updates were not established by this audit
---

# Version-prefixed workflow path migration

This source change retires three filenames. Their reusable capabilities, inputs,
outputs, jobs and permission envelopes remain at the canonical paths below.
Keep the existing channel selector and dual contract-lock policy when migrating.

| Retired path | Canonical path |
| --- | --- |
| `v4-adopter-delivery.yml` | `public-build-adopter-qualification.yml` |
| `v4-stage-capsule-canary.yml` | `public-build-stage-capsule-canary.yml` |
| `v4-tail-reseal.yml` | `public-ops-tail-reseal.yml` |

All paths are beneath `.github/workflows/`. The taxonomy gate rejects version
segments in filenames and calls to version-prefixed Buildchain workflows. An
explicit retirement record keeps the original migration identity for historical
metrics and frozen facade source; generators resolve that identity to the
canonical implementation and cannot recreate the removed file.

## Development merge and channel rollout

The development change retires these filenames on `dev/v4/v4.0`, updates the
Buildchain-owned callers, and enforces the canonical paths through generators
and required checks. Its delivery boundary is the protected development merge.
External-repository migration and stable publication are separate follow-up
work and do not block this development merge.

The published channel boundary still requires the following rollout order:

1. Publish and verify the canonical entries on every affected channel while the
   old entries remain available. The admission identity must match the actual
   invoked canonical workflow, rather than its previous filename.
2. Migrate consumers on their existing floating channels, refresh locks through
   the supported contract acceptance path if required, and verify real consumer
   runs. Stable callers remain on stable; alpha callers remain on alpha.
3. Before publishing the retirement into a channel, recheck its live consumers
   and resolve any remaining old-path calls. A protected development merge does
   not by itself establish this channel readiness.

## Initial consumer readback

On 2026-09-05, all workflow files from 23 accessible `kungfu-systems` repository
_default branches_ were read at their returned Git revisions. Five calls were
found in three repositories. This is a bounded inventory, not evidence that
unknown or non-default-branch consumers do not exist.

| Repository and observed revision | Caller | Existing selector |
| --- | --- | --- |
| Buildchain `d434a73d2d4fb010ee80fede2bf3ce872b1d04c8` | `self-build-adopter-dogfood.yml` | `v4-alpha` |
| Buildchain `d434a73d2d4fb010ee80fede2bf3ce872b1d04c8` | `self-build-public-consumer-dogfood.yml` | `v4-alpha` |
| agent-hub-demo `3f5de882b63464d70c50df0fd7ca418f487b794b` | `v4-adopter-delivery-qualification.yml` | `v4-alpha` |
| agent-hub-demo `3f5de882b63464d70c50df0fd7ca418f487b794b` | `v4-stage-capsule-canary.yml` | `v4` |
| taolu `6dcccdc3bd2c8b1801c7f6decea08ae7877aac2b` | `verify.yml` | `v4-alpha` |

The initial published channel readback was `v4` at
`da5e2db8384313e899eace87aea0a1a8e28c0aa8` and `v4-alpha` at
`dd87f43f7122b41c4ce7f1f6d1888521cc7f892f`. Neither contained the three canonical
filenames at that initial readback. The later evidence below records progress
without changing the scope or revisions of that initial inventory.

## Rollout evidence as of 2026-09-06

The canonical invocation-identity preparation was merged in
[Buildchain PR 3508](https://github.com/kungfu-systems/buildchain/pull/3508).
All three canonical paths are available in the immutable `v4.0.2-alpha.35`
release (`feab078f5d7c9927a3525154003e321700e8ca30`) and the later
`v4.0.2-alpha.37` release (`f5fa1a4a3e8d83eccee79c077e5f48417760c9df`).
The floating `v4-alpha` readback selects alpha.37.

[Taolu PR 30](https://github.com/kungfu-systems/taolu/pull/30) migrated its
Stage Capsule call on `@v4-alpha`, preserving the existing dual locks.
Its exact source `b3f4c12578d733ff44165ff1acafe131251b8907` passed
[consumer Verify](https://github.com/kungfu-systems/taolu/actions/runs/33975786413)
on all declared platforms and
[native delivery](https://github.com/kungfu-systems/taolu/actions/runs/34005576362).
The protected dev landing is `7e15123733110ad8ce484241934bbf0ef99fbb45`.

The stable `v4` readback remains
`da5e2db8384313e899eace87aea0a1a8e28c0aa8`, which does not contain the canonical
paths. Stable publication and the agent-hub-demo migration remain **pending**
outside this development change's completion boundary. The alpha.35
[Build Surface Fixture](https://github.com/kungfu-systems/buildchain/actions/runs/34005360217)
passed, but this individual result does not establish complete stable
qualification or authorize moving the stable channel.

## Recovery

Before channel retirement, revert consumer changes to the still-available old
paths if verification fails. After retirement, restore the exact previous
provider implementation through a reviewed corrective commit and normal
publication; do not rewrite immutable release tags or bypass admission checks.
