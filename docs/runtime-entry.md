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
last_reviewed: 2026-09-14
ai_provenance:
  model_family: GPT-6
  product: Codex
  generated_at: 2026-09-14
  visible_context: Source-bound recovery, nested delivery credential transport, published entry contract and local failure-path tests.
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
starting a new provider run through the corrected floating entry. The caller files
remain unchanged. A usable recovery entry can still recover the exact existing
attempt; an entry failure before admission has no attempt to recover.
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

## Minimal pipeline provider credentials

Configure `BUILDCHAIN_AUTOMATION_TOKEN` once as a repository Actions secret when
protected delivery requires permissions unavailable to `GITHUB_TOKEN`. Both
generated callers already inherit secrets. No token value, additional input or
provider orchestration belongs in the consumer TOML or workflow source.

Scope this credential to the consumer repository. Delivery needs Administration
read access to inspect classic branch locks, Checks read, and Actions, Contents,
Pull requests and Commit statuses write access for its existing provider steps.
It does not need permission to change branch protection or bypass review. Development
admission can fall back to `GITHUB_TOKEN`; unreadable protection still fails
closed before candidate reservation instead of assuming an unlocked branch.
Channel enqueue requires an explicit automation credential or an App installation
credential because `GITHUB_TOKEN` suppresses the required `merge_group` workflow.
Both central entries select that credential through the shared token provider;
queue reads and journal writes retain their existing workflow credential. An App
uses `BUILDCHAIN_APP_CLIENT_ID` and `BUILDCHAIN_APP_PRIVATE_KEY`, scoped to the
consumer repository with Pull requests write access. Missing or incomplete queue
credentials fail closed before enqueue.

The internal delivery edge forwards only this named secret to the credentialed
source, reservation, heartbeat and landing steps. Product builds, native
execution and native evidence sealing retain their separate read-only jobs and
receive no automation credential. Publication settlement uses the same canonical
secret as its existing fallback credential. Repairing a missing workflow secret
edge requires a corrected published entry and a new provider run.

## Minimal pipeline recovery

The minimal contract has one normal event caller and one manual recovery caller,
plus `.buildchain/buildchain.toml`. Both callers are maintained by Buildchain's
consumer setup; product differences do not require additional recovery workflows.
The repository implementation alone does not prove the entry has been published
or qualified in a clean consumer.

The workflow summary identifies the current attempt, its source PR, completed
steps and remaining work. Follow **Recover this attempt**, choose **Run workflow**,
and paste the exact attempt. Leave `runtime-ref` empty for an ordinary retry;
supply a repaired runtime only when needed. The public recovery entry accepts no
other recovery selectors. It derives configuration, producer runs, artifacts and
transaction coordinates from the canonical attempt history.

Recovery opens a new attempt with an explicit predecessor. Successful platform
jobs and their actual retained artifacts are independently requalified; only
missing platforms or explicitly incompatible stage implementations are rebuilt.
A signing failure can requalify the original sealed bytes under the repaired
publisher. Partial publication preserves its original signed transaction and
completed effects, reads providers again, and authorizes only remaining effects.
Missing, expired or conflicting evidence stops with a diagnosis; it does not
silently trigger a complete rebuild or replace published bytes.

A repeated request for the same predecessor and repair selects the same successor.
If that recovery was interrupted, select the successor shown in the summary for
the next recovery. An active predecessor must first finish or be cancelled using
its ordinary GitHub execution link. A changed or superseded source cannot reuse
an old attempt as authority for the current PR. Completed publication remains
recorded even when distribution or the next development version still needs work.
Cancellation stops remaining work and cannot undo published results.

Once admitted, ordinary wake events continue with the recovered attempt's exact
runtime, even when the consumer lock still names the original runtime. A further
runtime change requires another explicit recovery. An entry repair is distributed
through the existing `@v4` or `@v4-alpha` entry; consumers do not maintain backup
scripts, patch a job definition, or add a different recovery workflow family.

## Advanced build component recovery

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
the lock and requires caller repository write authority. For `workflow_dispatch`,
GitHub enforces repository Actions write permission before creating the run,
including calls using installation tokens. The entry uses that authorization;
an installation bot does not need to be a human repository collaborator.
Other event types retain the entry's write, maintain or admin collaborator check.
See GitHub's [workflow dispatch authorization](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
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
