---
status: draft
period: ongoing
theme: buildchain-shifu-gate-orchestration
doc_type: technical-manual
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: self-reviewed
last_reviewed: 2026-07-13
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-13
  invisible_context_boundary: No private runner configuration, credentials, or unpublished Shifu implementation state was used.
---

# Shifu Gate profile orchestration

Buildchain can schedule and aggregate a project-owned Shifu Gate profile without
owning that project's gate ids, commands, dependencies, or dev/alpha/release
policy. The reusable workflow is
`.github/workflows/.gate-profile.yml`.

## Ownership boundary

| Concern                                                                             | Owner                                 | Enforced surface                                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| Gate schema, profile planning, execution, receipt qualification                     | Shifu                                 | `shifu gate plan`, `shifu gate run --profile`, `shifu gate receipt validate` |
| Concrete gate catalog and profile decisions                                         | Consumer project                      | project Gate registry and detailed Gate docs                                 |
| Runner labels and declared capabilities                                             | Consumer workflow / Buildchain preset | `runner-preset` or `platforms-json`                                          |
| Deterministic runner matrix, immutable checkout, receipt transport, aggregate check | Buildchain                            | `.gate-profile.yml` and `shifu-gate-profile.mjs`                             |
| Whether a profile aggregate is required for dev, alpha, or release                  | Consumer project                      | protected-branch required-check policy and caller workflow                   |

Buildchain treats the Shifu plan and receipt as versioned input contracts. It
does not reimplement policy selection, execute raw shell strings, convert an
explicit diagnostic gate run into qualification, or mint missing evidence.

## Runner matrix

The plan job asks the consumer's Shifu entrypoint for one plan per configured
platform. A platform is dispatchable only when:

- the Shifu plan is qualifying;
- every required selection is supported on that platform;
- the runner declares every capability requested by the selected gates; and
- all platform plans carry the same project id and registry digest.

Configured platforms are required by default. A required platform that cannot
host the profile fails before runner dispatch. A platform with
`"required": false` may be omitted, but the omission and reasons remain in the
matrix and aggregate. Matrix entries retain the Shifu plan digest, ordered gate
groups, required/advisory modes, action ids, definition digests, skips, and
unsupported selections.

`github-hosted` declares only the inherent `node` capability. Projects that
need a native compiler, product artifacts, devices, or other facilities must
use a suitable preset or declare a custom matrix. Capabilities are scheduling
claims, not installation instructions.

```json
[
  {
    "id": "linux-native",
    "name": "Linux native",
    "platform": "linux",
    "runner": "[\"self-hosted\",\"Linux\",\"X64\",\"product-build\"]",
    "capabilities": ["node", "native-toolchain", "product-artifacts"]
  }
]
```

## Execution and receipts

Every matrix job checks out the exact source SHA planned by Buildchain, invokes
`shifu gate run --profile`, writes the receipt outside the source checkout, and
then invokes `shifu gate receipt validate`. Buildchain uploads the original
receipt and validation result even when the run fails.

The fixed `Gate profile / aggregate` job fails closed for missing receipts,
invalid or stale Shifu validation, dirty or mismatched source SHA, registry or
plan drift, missing required results, required failures/skips, or gate action
and definition digest drift. Advisory failures remain visible but do not turn a
Shifu-qualifying receipt into a required failure. Buildchain's aggregate is
`buildchain.shifu-gate-aggregate/v1`; its digest covers the matrix, receipts,
per-gate evidence pointers, omissions, and issues.

## Consumer workflow

```yaml
jobs:
  gates:
    uses: kungfu-systems/buildchain/.github/workflows/.gate-profile.yml@v2
    with:
      gate-profile: alpha-pr
      runner-preset: kungfu-v4-self-hosted
      include-advisory: true

  build:
    needs: gates
    uses: kungfu-systems/buildchain/.github/workflows/build.yml@v2
    with:
      release-candidate: true
      gate-profile-aggregate-json: ${{ needs.gates.outputs.gate-aggregate-json }}
```

The command input is an argv map, not a shell string. The default supports the
ordinary Shifu launcher names on all three platforms. A project with a
different launcher can override it without teaching Buildchain project tasks:

```yaml
gate-command-json: >-
  {"linux":["./tools/shifu"],"macos":["./tools/shifu"],"windows":["./tools/shifu.cmd"]}
```

Projects may also pass non-sensitive scalar environment through
`gate-environment-json`; Buildchain validates the JSON shape and forwards it
without interpreting names or values. Cache profile references use the same
opaque `shifu-cache-profile-ref` and `shifu-cache-profile-digest` inputs as the
reusable build. Do not place tokens, credentials, or other secrets in workflow
inputs or Gate receipts.

When a qualifying aggregate is passed to the build workflow, the
release-candidate passport binds its profile, source SHA, registry digest,
matrix digest, aggregate digest, receipt count, and result count. A failed,
non-qualifying, or source-mismatched aggregate cannot produce a valid passport.
Promote-only release validation preserves that same Gate evidence summary in
the final Release Passport release identity, so promotion cannot silently drop
the qualified profile provenance.

## Failure diagnosis and rollback

Start with the aggregate artifact, then the platform receipt named in its
issues. Reproduce the exact project decision with Shifu, for example:

```bash
./shifu gate explain <gate-id> --profile <profile>
./shifu gate plan <profile> --platform <platform> --json
./shifu gate receipt validate <receipt.json> --json
```

The existing reusable build workflow remains usable without Gate inputs. To
roll back Gate orchestration, remove the caller's `gates` job and
`gate-profile-aggregate-json` handoff; this does not alter the consumer's Shifu
registry or its direct diagnostic commands.

## Validation boundary

Unit fixtures prove deterministic matrix generation and required/advisory,
capability, unsupported, missing, stale, failure, and definition-drift
propagation. Because a train ref changes runtime scripts but not the outer
reusable workflow topology, an unreleased `.gate-profile.yml` must also be
validated through a trusted `workflow_dispatch` canary that references the
temporary workflow ref or exact SHA. See
[`runtime-train-validation.md`](runtime-train-validation.md).
