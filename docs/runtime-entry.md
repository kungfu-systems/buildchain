---
status: draft
period: ongoing
theme: unified-runtime-entry
doc_type: implementation-contract
source_level: user-consensus
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-11
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-11
  visible_context: Explicit user-approved runtime selection, recovery and alpha publication requirements.
  invisible_context_boundary: This contract does not claim implementation or hosted qualification is complete.
---

# Runtime entry contract

Consumers persist a public workflow reference at `@v4` or `@v4-alpha`.
GitHub resolves that entry to a commit. The entry selects execution runtime X
from an explicit transient parameter, the selected contract lock, or the entry
commit default, in that order. The entry commit and runtime commit may differ.

`actions/runtime/environment/prepare` is the sole runtime preparation owner.
Selection is resolved once per execution. Each executing job prepares that
selected runtime through the same implementation. Business workflows and
actions cannot acquire, replace, reselect or install their own Buildchain
runtime. All business composites, JavaScript modules, WASM and resources come
from X. Runtime identity is retained as provenance; subsequent business nodes
do not compare Buildchain SHAs or require equality with the workflow commit.

A runtime failure can start a recovery execution through the same public
entry with a transient repaired train branch or tag. The new execution selects
runtime Y and retains the original task, source and evidence. Valid completed
results can be reused; provider effects require readback before further writes.
Switching runtimes does not automatically qualify all previous results for reuse.
Neither the persisted caller nor its contract lock needs a train rewrite.

An entry failure is repaired by publishing and adopting a corrected entry and
starting a complete run. Recovering an invalid entry is not a runtime feature.
Buildchain self-dogfood uses exactly the same consumer contract and has no
repository-specific execution or recovery route.

Source checkouts are separate business inputs. Building Buildchain itself may
check out its source, but that source cannot implicitly replace the selected
execution runtime. Source, artifact and publication-effect checks retain their
business meaning; they do not reintroduce downstream Buildchain SHA checks.

Acceptance requires a complete workflow/action acquisition inventory, enforced
single preparation ownership, different entry/runtime execution, train recovery,
platform and multi-job qualification, and validation of the published consumer
entry. A source test or a successful package import alone is insufficient.

## Consumer build and recovery

```yaml
on:
  push:
  workflow_dispatch:
    inputs:
      runtime-ref:
        description: Optional repaired train for this execution
        default: ""
        type: string
      resume-run-id:
        description: Original failed build run to recover
        default: ""
        type: string
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/build.yml@v4
    with:
      runtime-ref: ${{ inputs.runtime-ref || '' }}
      resume-run-id: ${{ inputs.resume-run-id || '' }}
```

Ordinary executions use `.buildchain/contract-lock.json`; the alpha entry defaults
to `.buildchain/alpha-contract-lock.json`. `contract-lock` selects another relative
lock path. A missing default lock falls back to the entry commit; an invalid lock
or an unreadable source fails preparation. A supplied runtime parameter overrides
the lock and requires a caller repository actor with write, maintain or admin access.
Branches and tags are resolved to an immutable commit during selection.

For a Buildchain runtime fault, dispatch the same consumer workflow with
`runtime-ref: train/v4/v4.1/<repair>` and the original `resume-run-id`. The entry
retains the original source commit and rejects unrelated workflows or fork runs.
Install hydrates the new workspace; completed build outputs are restored only
when source, configuration, platform, tools, artifact producer and all retained
bytes qualify. The remaining verification runs with the repaired runtime.
Existing provider effects use their transaction evidence and live readbacks.
A failed-job rerun cannot supply new inputs; recovery therefore starts a new run.

`runtime-selection` is an internal reusable-workflow transport for an already
selected runtime. Components forward it unchanged instead of resolving another
reference. Consumers normally supply `runtime-ref` or a lock, not this transport.

Nested components preserve the selected runtime and contract metadata without
re-reading the lock or comparing the runtime SHA. The internal transport carries
a trusted entry output; consumer source binding and override authorization remain
entry concerns. Recovery selectors request `actions: read` to read the original
run in private repositories as well as public repositories.

Business adapters also keep the runtime installation directory separate from the
consumer workspace. Queue reconciliation, npm preview, runner qualification and
binary packaging read consumer source from the workspace while executing selected
runtime code. Directory equality is not an admission rule; source SHA and artifact
containment checks still apply. The architecture gate parses business JavaScript
and rejects direct or aliased runtime/source directory equality comparisons.

Publication authority adapters take runtime repository and revision provenance
from the prepared entry selection. Consumer requests provide source, artifact
and effect authority; they do not supply or readmit a Buildchain SHA. Governance
and sealed publication evidence retain the selected runtime as provenance while
validating their own source, policy and provider bindings.
